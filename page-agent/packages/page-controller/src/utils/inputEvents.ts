export interface KeyModifiers {
	alt?: boolean
	ctrl?: boolean
	meta?: boolean
	shift?: boolean
}

export function normalizeModifiers(modifiers?: KeyModifiers) {
	return {
		altKey: !!modifiers?.alt,
		ctrlKey: !!modifiers?.ctrl,
		metaKey: !!modifiers?.meta,
		shiftKey: !!modifiers?.shift,
	}
}

export function dispatchKeySequence(
	target: EventTarget,
	options: {
		key: string
		code?: string
		modifiers?: KeyModifiers
		includeKeyPress?: boolean
	}
) {
	const { altKey, ctrlKey, metaKey, shiftKey } = normalizeModifiers(options.modifiers)
	const common: KeyboardEventInit = {
		key: options.key,
		code: options.code ?? '',
		altKey,
		ctrlKey,
		metaKey,
		shiftKey,
		bubbles: true,
		cancelable: true,
		composed: true,
	}

	target.dispatchEvent(new KeyboardEvent('keydown', common))

	const includeKeyPress =
		options.includeKeyPress ??
		(options.key.length === 1 && !ctrlKey && !metaKey && !altKey)
	if (includeKeyPress) {
		target.dispatchEvent(new KeyboardEvent('keypress', common))
	}

	target.dispatchEvent(new KeyboardEvent('keyup', common))
}

export async function dispatchPointerDrag(options: {
	doc: Document
	start: { x: number; y: number }
	end: { x: number; y: number }
	steps?: number
}) {
	const steps = Math.max(1, Math.min(100, options.steps ?? 12))
	const doc = options.doc

	const getTarget = (x: number, y: number) => (doc.elementFromPoint(x, y) as HTMLElement | null) ?? doc.body

	const startTarget = getTarget(options.start.x, options.start.y)
	const endTarget = getTarget(options.end.x, options.end.y)

	const pointerSupported = typeof (doc.defaultView as any)?.PointerEvent === 'function'
	const createPointerEvent = (type: string, x: number, y: number, down: boolean) => {
		const init = {
			bubbles: true,
			cancelable: true,
			composed: true,
			clientX: x,
			clientY: y,
			pointerType: 'mouse',
			isPrimary: true,
			button: 0,
			buttons: down ? 1 : 0,
		}
		return pointerSupported
			? new (doc.defaultView as any).PointerEvent(type, init)
			: null
	}

	const createMouseEvent = (type: string, x: number, y: number, down: boolean) =>
		new MouseEvent(type, {
			bubbles: true,
			cancelable: true,
			composed: true,
			clientX: x,
			clientY: y,
			button: 0,
			buttons: down ? 1 : 0,
		})

	const startX = options.start.x
	const startY = options.start.y
	const endX = options.end.x
	const endY = options.end.y

	const overPe = createPointerEvent('pointerover', startX, startY, false)
	if (overPe) startTarget.dispatchEvent(overPe)
	startTarget.dispatchEvent(createMouseEvent('mouseover', startX, startY, false))

	const downPe = createPointerEvent('pointerdown', startX, startY, true)
	if (downPe) startTarget.dispatchEvent(downPe)
	startTarget.dispatchEvent(createMouseEvent('mousedown', startX, startY, true))

	for (let i = 1; i <= steps; i++) {
		const t = i / steps
		const x = startX + (endX - startX) * t
		const y = startY + (endY - startY) * t
		const target = getTarget(x, y)
		const movePe = createPointerEvent('pointermove', x, y, true)
		if (movePe) target.dispatchEvent(movePe)
		target.dispatchEvent(createMouseEvent('mousemove', x, y, true))
	}

	const upPe = createPointerEvent('pointerup', endX, endY, false)
	if (upPe) endTarget.dispatchEvent(upPe)
	endTarget.dispatchEvent(createMouseEvent('mouseup', endX, endY, false))
}
