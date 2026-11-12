import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import './reading-search.css'

/** Shared keyboard shell for the reading explorer and its personal dictionary. */
export function ToolDialog({ title, children, onClose, className = '' }: {
  title: string; children: ReactNode; onClose: () => void; className?: string
}) {
  const element = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    const trigger = document.activeElement as HTMLElement | null
    const dialog = element.current
    dialog?.focus()
    return () => {
      // A command may already have focused the editor. Never override it.
      if ((dialog?.contains(document.activeElement) || document.activeElement === document.body)
        && trigger?.isConnected && trigger.getClientRects().length) trigger.focus()
    }
  }, [])
  return createPortal(<div className="tool-dialog-backdrop" onPointerDown={event => {
    if (event.target === event.currentTarget) onClose()
  }}>
    <section ref={element} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title}
      className={`tool-dialog ${className}`} onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return }
        if (event.key !== 'Tab') return
        const items = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"],summary')]
          .filter(node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden')
        const first = items[0]; const last = items.at(-1)
        if (!items.length) { event.preventDefault(); return }
        if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }}>
      <header className="tool-dialog-heading"><h2>{title}</h2><button aria-label={`${title}を閉じる`} onClick={onClose}><X size={18} /></button></header>
      {children}
    </section>
  </div>, document.body)
}
