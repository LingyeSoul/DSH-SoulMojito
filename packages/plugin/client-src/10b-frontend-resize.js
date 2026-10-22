    // Manual frontend height (2026-10-22): cards such as the galgame frontend
    // lay out against their own 100vh, so the reported content height never
    // grows past the initial iframe and the panel stays clipped. The handle
    // lets the user own the height; null means "follow the card's report".
    const FRONTEND_MANUAL_MIN_HEIGHT = 120
    const FRONTEND_MANUAL_MAX_HEIGHT = 4000
    const FRONTEND_MANUAL_STEP = 40

    function useFrontendResize(frameRef, autoHeight, ready) {
      const [manualHeight, setManualHeight] = useState(null)
      const [dragging, setDragging] = useState(false)
      const manualHeightRef = useRef(null)
      const dragRef = useRef(null)
      // Card frame.prefs set height with !important; the manual override must
      // win and survive auto-height reports while the user is dragging.
      useLayoutEffect(() => {
        const frame = frameRef.current
        if (frame === null || manualHeight === null) return
        frame.style.setProperty('height', `${manualHeight}px`, 'important')
      }, [manualHeight, autoHeight, ready])
      const commit = (value) => {
        manualHeightRef.current = value
        setManualHeight(value)
      }
      const reset = () => {
        manualHeightRef.current = null
        setManualHeight(null)
        frameRef.current?.style.removeProperty('height')
      }
      const startResize = (event) => {
        if (event.button !== 0) return
        dragRef.current = {
          pointerId: event.pointerId,
          startY: event.clientY,
          startHeight: manualHeightRef.current ?? autoHeight,
        }
        try { event.currentTarget.setPointerCapture(event.pointerId) } catch {}
        setDragging(true)
        event.preventDefault()
      }
      const moveResize = (event) => {
        const drag = dragRef.current
        if (drag === null || drag.pointerId !== event.pointerId) return
        const next = Math.max(
          FRONTEND_MANUAL_MIN_HEIGHT,
          Math.min(FRONTEND_MANUAL_MAX_HEIGHT, Math.round(drag.startHeight + event.clientY - drag.startY)),
        )
        commit(next)
      }
      const endResize = (event) => {
        if (dragRef.current === null) return
        dragRef.current = null
        setDragging(false)
        try { event.currentTarget.releasePointerCapture(event.pointerId) } catch {}
      }
      const keyResize = (event) => {
        if (event.key === 'Home') {
          event.preventDefault()
          reset()
          return
        }
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
        event.preventDefault()
        const current = manualHeightRef.current ?? autoHeight
        const delta = event.key === 'ArrowDown' ? FRONTEND_MANUAL_STEP : -FRONTEND_MANUAL_STEP
        commit(Math.max(
          FRONTEND_MANUAL_MIN_HEIGHT,
          Math.min(FRONTEND_MANUAL_MAX_HEIGHT, current + delta),
        ))
      }
      return {
        manualHeight,
        dragging,
        effectiveHeight: manualHeight === null ? autoHeight : manualHeight,
        manualHeightRef,
        startResize,
        moveResize,
        endResize,
        resetManualHeight: reset,
        keyResize,
      }
    }
