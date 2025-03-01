import {PaintOrder, PathCommand, LineCap, LineJoin, PathRule, MaskType} from './usvg_pb_decoder.js';

import type {UsvgTree, Icon, Group, Node, Path, Transform, ClipPath, Mask, LinearGradient, RadialGradient} from './usvg_pb_decoder';

/**
 * Renders a uSVG icon to an ImageData object.
 *
 * @param icon uSVG icon.
 * @param transform Transformation matrix.
 * @returns ImageData object.
 */
export function renderIcon(icon: Icon, transform?: DOMMatrix): ImageData {
    const tree = icon.usvg_tree;

    let naturalWidth = tree.width;
    let naturalHeight = tree.height;
    if (naturalWidth == null || naturalHeight == null) {
        naturalWidth = naturalWidth || 0;
        naturalHeight = naturalHeight || naturalWidth;
    }

    const tr = transform ? transform : new DOMMatrix();
    const renderedWidth = Math.round(naturalWidth * tr.a); // transform.sx
    const renderedHeight = Math.round(naturalHeight * tr.d); // transform.sy

    const offscreenCanvas = new OffscreenCanvas(renderedWidth, renderedHeight);
    const context = offscreenCanvas.getContext('2d');

    renderNodes(context, tr, tree, tree as unknown as Group);
    return context.getImageData(0, 0, renderedWidth, renderedHeight);
}

function renderNodes(context: OffscreenCanvasRenderingContext2D, transform: DOMMatrix, tree: UsvgTree, parent: Group) {
    for (const node of parent.children) {
        renderNode(context, transform, tree, node);
    }
}

function renderNode(context: OffscreenCanvasRenderingContext2D, transform: DOMMatrix, tree: UsvgTree, node: Node) {
    if (node.group) {
        context.save();
        renderGroup(context, transform, tree, node.group);
        context.restore();
    } else if (node.path) {
        context.save();
        renderPath(context, transform, tree, node.path);
        context.restore();
    } else {
        assert(false, 'Not implemented');
    }
}

function shouldIsolate(group: Group, hasClipPath: boolean, hasMask: boolean): boolean {
    return group.opacity !== 255 || hasClipPath || hasMask;
}

function renderGroup(context: OffscreenCanvasRenderingContext2D, transform: DOMMatrix, tree: UsvgTree, group: Group) {
    const mask = group.mask_idx != null ? tree.masks[group.mask_idx] : null;
    const clipPath = group.clip_path_idx != null ? tree.clip_paths[group.clip_path_idx] : null;

    if (group.transform) {
        transform = makeTransform(group.transform).preMultiplySelf(transform);
    }

    if (!shouldIsolate(group, clipPath != null, mask != null)) {
        renderNodes(context, transform, tree, group);
        return;
    }

    const groupCanvas = new OffscreenCanvas(context.canvas.width, context.canvas.height);
    const groupContext = groupCanvas.getContext('2d');

    if (clipPath) {
        applyClipPath(groupContext, transform, tree, clipPath);
    }

    renderNodes(groupContext, transform, tree, group);

    if (mask) {
        applyMask(groupContext, transform, tree, mask);
    }

    context.globalAlpha = group.opacity / 255;
    context.drawImage(groupCanvas, 0, 0);
}

function renderPath(context: OffscreenCanvasRenderingContext2D, transform: DOMMatrix, tree: UsvgTree, path: Path) {
    const path2d = makePath2d(path);
    context.setTransform(transform);

    if (path.paint_order === PaintOrder.PAINT_ORDER_FILL_AND_STROKE) {
        fillPath(context, tree, path, path2d);
        strokePath(context, tree, path, path2d);
    } else {
        strokePath(context, tree, path, path2d);
        fillPath(context, tree, path, path2d);
    }
}

function fillPath(context: OffscreenCanvasRenderingContext2D, tree: UsvgTree, path: Path, path2d: Path2D) {
    const fill = path.fill;
    if (!fill) return;

    const alpha = fill.opacity / 255;

    switch (fill.paint) {
    case 'rgb_color':
        context.fillStyle = toRGBA(fill.rgb_color, fill.opacity);
        break;
    case 'linear_gradient_idx':
        context.fillStyle = convertLinearGradient(context, tree.linear_gradients[fill.linear_gradient_idx], alpha);
        break;
    case 'radial_gradient_idx':
        context.fillStyle = convertRadialGradient(context, tree.radial_gradients[fill.radial_gradient_idx], alpha);
    }

    let fillRule: CanvasFillRule;
    switch (path.rule) {
    case PathRule.PATH_RULE_NON_ZERO:
        fillRule = 'nonzero';
        break;
    case PathRule.PATH_RULE_EVEN_ODD:
        fillRule = 'evenodd';
    }

    context.fill(path2d, fillRule);
}

function strokePath(context: OffscreenCanvasRenderingContext2D, tree: UsvgTree, path: Path, path2d: Path2D) {
    const stroke = path.stroke;
    if (!stroke) return;

    context.lineWidth = stroke.width;
    context.miterLimit = stroke.miterlimit;
    context.setLineDash(stroke.dasharray);
    context.lineDashOffset = stroke.dashoffset;

    const alpha = stroke.opacity / 255;

    switch (stroke.paint) {
    case 'rgb_color':
        context.strokeStyle = toRGBA(stroke.rgb_color, stroke.opacity);
        break;
    case 'linear_gradient_idx':
        context.strokeStyle = convertLinearGradient(context, tree.linear_gradients[stroke.linear_gradient_idx], alpha);
        break;
    case 'radial_gradient_idx':
        context.strokeStyle = convertRadialGradient(context, tree.radial_gradients[stroke.radial_gradient_idx], alpha);
    }

    switch (stroke.linejoin) {
    case LineJoin.LINE_JOIN_MITER_CLIP:
    case LineJoin.LINE_JOIN_MITER:
        context.lineJoin = 'miter';
        break;
    case LineJoin.LINE_JOIN_ROUND:
        context.lineJoin = 'round';
        break;
    case LineJoin.LINE_JOIN_BEVEL:
        context.lineJoin = 'bevel';
    }

    switch (stroke.linecap) {
    case LineCap.LINE_CAP_BUTT:
        context.lineCap = 'butt';
        break;
    case LineCap.LINE_CAP_ROUND:
        context.lineCap = 'round';
        break;
    case LineCap.LINE_CAP_SQUARE:
        context.lineCap = 'square';
    }

    context.stroke(path2d);
}

function convertLinearGradient(context: OffscreenCanvasRenderingContext2D, gradient: LinearGradient, alpha: number): CanvasGradient | string {
    if (gradient.stops.length === 1) {
        const stop = gradient.stops[0];
        return toRGBA(stop.rgb_color, stop.opacity * alpha);
    }

    const tr = makeTransform(gradient.transform);
    const {x1, y1, x2, y2} = gradient;
    const start = tr.transformPoint(new DOMPoint(x1, y1));
    const end = tr.transformPoint(new DOMPoint(x2, y2));

    const linearGradient = context.createLinearGradient(start.x, start.y, end.x, end.y);
    for (const stop of gradient.stops) {
        linearGradient.addColorStop(stop.offset, toRGBA(stop.rgb_color, stop.opacity * alpha));
    }

    return linearGradient;
}

function convertRadialGradient(context: OffscreenCanvasRenderingContext2D, gradient: RadialGradient, alpha: number): CanvasGradient | string {
    if (gradient.stops.length === 1) {
        const stop = gradient.stops[0];
        return toRGBA(stop.rgb_color, stop.opacity * alpha);
    }

    const tr = makeTransform(gradient.transform);
    const {fx, fy, cx, cy} = gradient;
    const start = tr.transformPoint(new DOMPoint(fx, fy));
    const end = tr.transformPoint(new DOMPoint(cx, cy));

    // Extract the scale component from the transform
    const uniformScale = (tr.a + tr.d) / 2;
    const r1 = gradient.r * uniformScale;

    const radialGradient = context.createRadialGradient(start.x, start.y, 0, end.x, end.y, r1);
    for (const stop of gradient.stops) {
        radialGradient.addColorStop(stop.offset, toRGBA(stop.rgb_color, stop.opacity * alpha));
    }

    return radialGradient;
}

function applyClipPath(context: OffscreenCanvasRenderingContext2D, transform: DOMMatrix, tree: UsvgTree, clipPath: ClipPath) {
    const tr = makeTransform(clipPath.transform).preMultiplySelf(transform);

    const selfClipPath = clipPath.clip_path_idx != null ? tree.clip_paths[clipPath.clip_path_idx] : null;
    if (selfClipPath) {
        applyClipPath(context, tr, tree, selfClipPath);
    }

    const path2d = new Path2D();
    let fillRule;

    function addNode(node, tr) {
        if (node.path) {
            const path = node.path;
            path2d.addPath(makePath2d(path), tr);

            // Canvas doesn't support mixed fill rules in a single clip path, so we'll use evenodd for whole path if one part has it
            if (path.rule === PathRule.PATH_RULE_EVEN_ODD) fillRule = 'evenodd';

        } else if (node.group) {
            const childTr = node.group.transform ? makeTransform(node.group.transform).preMultiplySelf(tr) : tr;
            for (const child of node.group.children) {
                addNode(child, childTr);
            }
        }
    }

    for (const node of clipPath.children) {
        addNode(node, tr);
    }

    context.clip(path2d, fillRule);
}

function applyMask(context: OffscreenCanvasRenderingContext2D, transform: DOMMatrix, tree: UsvgTree, mask: Mask) {
    if (mask.children.length === 0) {
        return;
    }

    const childMask = mask.mask_idx != null ? tree.masks[mask.mask_idx] : null;
    if (childMask) {
        applyMask(context, transform, tree, childMask);
    }

    const width = context.canvas.width;
    const height = context.canvas.height;

    const maskCanvas = new OffscreenCanvas(width, height);

    const maskContext = maskCanvas.getContext('2d');

    // clip mask to its defined size
    const maskWidth = mask.width || 0;
    const maskHeight = mask.height || maskWidth;
    const maskLeft = mask.left || 0;
    const maskTop = mask.top || maskLeft;
    const clipPath = new Path2D();
    const rect = new Path2D();
    rect.rect(maskLeft, maskTop, maskWidth, maskHeight);
    clipPath.addPath(rect, transform);
    maskContext.clip(clipPath);

    for (const node of mask.children) {
        renderNode(maskContext, transform, tree, node);
    }

    const maskImageData = maskContext.getImageData(0, 0, width, height);
    const maskData = maskImageData.data;

    if (mask.mask_type === MaskType.MASK_TYPE_LUMINANCE) {
        // Set alpha to luminance
        for (let i = 0; i < maskData.length; i += 4) {
            const r = maskData[i];
            const g = maskData[i + 1];
            const b = maskData[i + 2];
            const a = maskData[i + 3] / 255;
            const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            maskData[i + 3] = luminance * a;
        }
    }

    maskContext.putImageData(maskImageData, 0, 0);

    context.globalCompositeOperation = 'destination-in';
    context.drawImage(maskCanvas, 0, 0);
}

function toRGBA(color: number, opacity: number = 255) {
    return `rgba(${(color >> 16) & 255}, ${(color >> 8) & 255}, ${color & 255}, ${opacity / 255})`;
}

// Transform
// sx kx tx
// ky sy ty
//  0  0  1
function makeTransform(transform?: Transform) {
    return transform ?
        new DOMMatrix([transform.sx, transform.ky, transform.kx, transform.sy, transform.tx, transform.ty]) :
        new DOMMatrix();
}

function makePath2d(path: Path): Path2D {
    const path2d = new Path2D();
    const step = path.step || 1;

    let x = path.diffs[0] * step;
    let y = path.diffs[1] * step;
    path2d.moveTo(x, y);

    for (let i = 0, j = 2; i < path.commands.length; i++) {
        switch (path.commands[i]) {
        case PathCommand.PATH_COMMAND_MOVE: {
            x += path.diffs[j++] * step;
            y += path.diffs[j++] * step;
            path2d.moveTo(x, y);
            break;
        }
        case PathCommand.PATH_COMMAND_LINE: {
            x += path.diffs[j++] * step;
            y += path.diffs[j++] * step;
            path2d.lineTo(x, y);
            break;
        }
        case PathCommand.PATH_COMMAND_QUAD: {
            const cpx = x + path.diffs[j++] * step;
            const cpy = y + path.diffs[j++] * step;
            x = cpx + path.diffs[j++] * step;
            y = cpy + path.diffs[j++] * step;
            path2d.quadraticCurveTo(cpx, cpy, x, y);
            break;
        }
        case PathCommand.PATH_COMMAND_CUBIC: {
            const cp1x = x + path.diffs[j++] * step;
            const cp1y = y + path.diffs[j++] * step;
            const cp2x = cp1x + path.diffs[j++] * step;
            const cp2y = cp1y + path.diffs[j++] * step;
            x = cp2x + path.diffs[j++] * step;
            y = cp2y + path.diffs[j++] * step;
            path2d.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y);
            break;
        }
        case PathCommand.PATH_COMMAND_CLOSE: {
            path2d.closePath();
            break;
        }
        default:
            assert(false, `Unknown path command "${path.commands[i]}"`);
        }
    }

    return path2d;
}

function assert(condition: boolean, message: string) {
    console.assert(condition, message);
}
