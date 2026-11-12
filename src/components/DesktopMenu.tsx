import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { Activity, Check, ChevronDown, ChevronRight } from 'lucide-react'
import './desktop-menu.css'

export interface MenuCommand {
  id: string
  label: string
  shortcut?: string
  disabled?: boolean
  checked?: boolean
  onSelect: () => void
}

export interface MenuGroup {
  id: string
  label: string
  items: (MenuCommand | { separator: true })[]
}

export interface DesktopMenuProps {
  groups: MenuGroup[]
  mode: 'bar' | 'compact'
  onModeChange: (mode: 'bar' | 'compact') => void
}

type OpenMenu = { source: 'bar'; groupId: string } | { source: 'logo'; groupId: string | null }
type FocusRequest = { kind: 'bar' | 'category'; index: number } | { kind: 'command'; groupId: string; last: boolean }

function commands(group: MenuGroup) {
  return group.items.filter((item): item is MenuCommand => !('separator' in item))
}

/** Fixed popups stay inside the viewport, independently of header overflow. */
function MenuPopup({ anchor, side = false, children, ...attributes }: {
  anchor: HTMLElement | null
  side?: boolean
  children: ReactNode
  id: string
  'aria-label'?: string
  'aria-labelledby'?: string
}) {
  const element = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const panel = element.current
    if (!panel || !anchor) return
    const place = () => {
      const bounds = anchor.getBoundingClientRect()
      const menu = panel.getBoundingClientRect()
      const margin = 8
      const gap = 3
      let left = side ? bounds.right + gap : bounds.left
      let top = side ? bounds.top : bounds.bottom + gap
      if (side && left + menu.width > innerWidth - margin) left = bounds.left - menu.width - gap
      if (!side && top + menu.height > innerHeight - margin && bounds.top - menu.height - gap >= margin) top = bounds.top - menu.height - gap
      left = Math.max(margin, Math.min(left, innerWidth - menu.width - margin))
      top = Math.max(margin, Math.min(top, innerHeight - menu.height - margin))
      // Layout effects run from the popup to its parent. Make the DOM visible
      // here, before DesktopMenu's layout effect focuses an item; a state
      // update would leave that focus attempt targeting a still-hidden node.
      panel.style.left = `${left}px`
      panel.style.top = `${top}px`
      panel.style.visibility = 'visible'
    }
    place()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place)
    observer?.observe(panel)
    observer?.observe(anchor)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [anchor, side])
  return <div {...attributes} ref={element} role="menu" className="desktop-menu__popup" style={{ visibility: 'hidden' }}>{children}</div>
}

/** Mode commands are supplied by the caller's View group, alongside its other commands. */
export function DesktopMenu({ groups, mode }: DesktopMenuProps) {
  const prefix = useId()
  const root = useRef<HTMLDivElement>(null)
  const portal = useRef<HTMLDivElement>(null)
  const logo = useRef<HTMLButtonElement>(null)
  const barButtons = useRef(new Map<string, HTMLButtonElement>())
  const categoryButtons = useRef(new Map<string, HTMLButtonElement>())
  const commandButtons = useRef(new Map<string, HTMLButtonElement>())
  const returnFocus = useRef<HTMLElement | null>(null)
  const focusRequest = useRef<FocusRequest | null>(null)
  const composing = useRef(false)
  const [open, setOpen] = useState<OpenMenu | null>(null)
  const [barIndex, setBarIndex] = useState(0)
  const previousMode = useRef(mode)
  const activeGroup = groups.find(group => group.id === open?.groupId)
  const groupIndex = (group: MenuGroup) => groups.findIndex(item => item.id === group.id)
  const triggerId = (source: 'bar' | 'logo', index: number) => `${prefix}-${source}-${index}`
  const panelId = (source: 'bar' | 'logo', index: number) => `${prefix}-${source}-panel-${index}`
  const commandKey = (groupId: string, commandId: string) => JSON.stringify([groupId, commandId])

  function owns(target: Node | null) {
    return Boolean(target && (root.current?.contains(target) || portal.current?.contains(target)))
  }

  function rememberContext() {
    const current = document.activeElement
    if (current instanceof HTMLElement && current !== document.body && !owns(current)) returnFocus.current = current
  }

  function focus(target: HTMLElement | null | undefined, reveal = false) {
    if (!target) return
    target.focus({ preventScroll: true })
    if (reveal) target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  function close(restore: 'context' | 'logo' | 'none' = 'none') {
    focusRequest.current = null
    // Remove menus before commands can open a dialog or focus an editor. There
    // is deliberately no deferred focus effect after command execution.
    flushSync(() => setOpen(null))
    if (restore === 'logo') focus(logo.current)
    if (restore === 'context') focus(returnFocus.current?.isConnected ? returnFocus.current : logo.current)
  }

  function openBar(index: number, edge: 'first' | 'last' | 'bar' = 'first') {
    const group = groups[index]
    if (!group) return
    rememberContext()
    setBarIndex(index)
    focusRequest.current = edge === 'bar' || !commands(group).length
      ? { kind: 'bar', index }
      : { kind: 'command', groupId: group.id, last: edge === 'last' }
    setOpen({ source: 'bar', groupId: group.id })
  }

  function openLogo(index = 0) {
    rememberContext()
    focusRequest.current = { kind: 'category', index }
    setOpen({ source: 'logo', groupId: null })
  }

  function openCategory(index: number, enter = true) {
    const group = groups[index]
    if (!group) return
    focusRequest.current = enter && commands(group).length
      ? { kind: 'command', groupId: group.id, last: false }
      : { kind: 'category', index }
    setOpen({ source: 'logo', groupId: group.id })
  }

  function execute(command: MenuCommand) {
    if (command.disabled) return
    close('context')
    command.onSelect()
  }

  function ignoreKey(event: KeyboardEvent | globalThis.KeyboardEvent) {
    const native = 'nativeEvent' in event ? event.nativeEvent : event
    const active = composing.current || native.isComposing || native.keyCode === 229
    // A focused button's native Enter/Space activation must not turn an IME
    // confirmation into a menu command after our own handler declines it.
    if (active && 'nativeEvent' in event && (event.key === 'Enter' || event.key === ' ')) event.preventDefault()
    return active
  }

  function leaveWithTab(event: KeyboardEvent) {
    const menuRoot = root.current
    if (!menuRoot) return
    const tabbables = [...document.querySelectorAll<HTMLElement>(
      'a[href],button,input,select,textarea,[tabindex],[contenteditable="true"]',
    )].filter(element => element.tabIndex >= 0 && !owns(element)
      && !element.matches(':disabled') && !element.closest('[inert]')
      && getComputedStyle(element).visibility !== 'hidden' && element.getClientRects().length > 0)
    const direction = event.shiftKey ? Node.DOCUMENT_POSITION_PRECEDING : Node.DOCUMENT_POSITION_FOLLOWING
    const candidates = tabbables.filter(element => menuRoot.compareDocumentPosition(element) & direction)
    const destination = event.shiftKey ? candidates.at(-1) : candidates[0]
    close('none')
    if (destination) {
      event.preventDefault()
      focus(destination)
    } else {
      // At a document edge, let the browser move focus into its own chrome.
      focus(logo.current)
    }
  }

  function barKey(event: KeyboardEvent, index: number) {
    if (ignoreKey(event)) return
    if (event.key === 'Tab') { leaveWithTab(event); return }
    let next: number
    if (event.key === 'ArrowRight') next = (index + 1) % groups.length
    else if (event.key === 'ArrowLeft') next = (index + groups.length - 1) % groups.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = groups.length - 1
    else if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
      event.preventDefault()
      openBar(index, event.key === 'ArrowUp' ? 'last' : 'first')
      return
    } else if (event.key === 'Escape') { event.preventDefault(); close('context'); return }
    else return
    event.preventDefault()
    if (open?.source === 'bar') openBar(next, 'bar')
    else { setBarIndex(next); focus(barButtons.current.get(groups[next].id)) }
  }

  function categoryKey(event: KeyboardEvent, index: number) {
    if (ignoreKey(event)) return
    if (event.key === 'Tab') { leaveWithTab(event); return }
    if (['ArrowRight', 'Enter', ' '].includes(event.key)) {
      event.preventDefault(); openCategory(index); return
    }
    if (event.key === 'Escape' || event.key === 'ArrowLeft') { event.preventDefault(); close('logo'); return }
    let next: number
    if (event.key === 'ArrowDown') next = (index + 1) % groups.length
    else if (event.key === 'ArrowUp') next = (index + groups.length - 1) % groups.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = groups.length - 1
    else return
    event.preventDefault()
    openLogo(next)
  }

  function commandKeyDown(event: KeyboardEvent, group: MenuGroup, command: MenuCommand) {
    if (ignoreKey(event)) return
    if (event.key === 'Tab') { leaveWithTab(event); return }
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); execute(command); return }
    if (event.key === 'Escape' || (event.key === 'ArrowLeft' && open?.source === 'logo')) {
      event.preventDefault()
      if (open?.source === 'logo') openLogo(groupIndex(group))
      else { close(); focus(barButtons.current.get(group.id)) }
      return
    }
    if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && open?.source === 'bar') {
      event.preventDefault()
      openBar((groupIndex(group) + (event.key === 'ArrowLeft' ? groups.length - 1 : 1)) % groups.length)
      return
    }
    const items = commands(group)
    const index = items.findIndex(item => item.id === command.id)
    let next: number
    if (event.key === 'ArrowDown') next = (index + 1) % items.length
    else if (event.key === 'ArrowUp') next = (index + items.length - 1) % items.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = items.length - 1
    else return
    event.preventDefault()
    focus(commandButtons.current.get(commandKey(group.id, items[next].id)), true)
  }

  useLayoutEffect(() => {
    const request = focusRequest.current
    focusRequest.current = null
    if (!request) return
    if (request.kind === 'command') {
      const group = groups.find(item => item.id === request.groupId)
      const items = group ? commands(group) : []
      const command = request.last ? items.at(-1) : items[0]
      if (command) focus(commandButtons.current.get(commandKey(request.groupId, command.id)), true)
    } else {
      const group = groups[request.index]
      if (group) focus((request.kind === 'bar' ? barButtons : categoryButtons).current.get(group.id), request.kind === 'category')
    }
  }, [open, groups])

  useEffect(() => {
    if (previousMode.current !== mode) {
      previousMode.current = mode
      focusRequest.current = null
      setOpen(null)
    }
  }, [mode])

  useEffect(() => {
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (document.activeElement?.closest('[role="dialog"][aria-modal="true"]')) return
      if (ignoreKey(event) || event.key !== 'F10' || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      event.preventDefault()
      rememberContext()
      if (mode === 'bar' && groups.length) {
        close()
        setBarIndex(0)
        focus(barButtons.current.get(groups[0].id))
      } else openLogo()
    }
    const pointerdown = (event: PointerEvent) => {
      if (open && !owns(event.target as Node)) close()
    }
    const focusin = (event: FocusEvent) => {
      const target = event.target
      if (target instanceof HTMLElement && target !== document.body && !owns(target)) {
        returnFocus.current = target
        if (open) { focusRequest.current = null; setOpen(null) }
      }
    }
    const startComposition = () => { composing.current = true }
    const endComposition = () => { composing.current = false }
    document.addEventListener('keydown', keydown, true)
    document.addEventListener('pointerdown', pointerdown, true)
    document.addEventListener('focusin', focusin)
    document.addEventListener('compositionstart', startComposition, true)
    document.addEventListener('compositionend', endComposition, true)
    return () => {
      document.removeEventListener('keydown', keydown, true)
      document.removeEventListener('pointerdown', pointerdown, true)
      document.removeEventListener('focusin', focusin)
      document.removeEventListener('compositionstart', startComposition, true)
      document.removeEventListener('compositionend', endComposition, true)
    }
  }, [open, mode, groups])

  function renderCommands(group: MenuGroup, source: 'bar' | 'logo') {
    const index = groupIndex(group)
    return <MenuPopup id={panelId(source, index)} aria-labelledby={triggerId(source, index)}
      anchor={(source === 'bar' ? barButtons : categoryButtons).current.get(group.id) ?? null} side={source === 'logo'}>
      {group.items.map((item, itemIndex) => 'separator' in item
        ? <div key={`separator-${itemIndex}`} role="separator" aria-orientation="horizontal" className="desktop-menu__separator" />
        : <button key={item.id} type="button" className="desktop-menu__command" tabIndex={-1}
          role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
          aria-checked={item.checked} aria-disabled={item.disabled || undefined}
          ref={element => { const key = commandKey(group.id, item.id); if (element) commandButtons.current.set(key, element); else commandButtons.current.delete(key) }}
          onKeyDown={event => commandKeyDown(event, group, item)}
          onPointerMove={event => { if (event.pointerType === 'mouse') focus(event.currentTarget) }}
          onClick={() => execute(item)}>
          <span className="desktop-menu__check" aria-hidden="true">{item.checked && <Check size={15} strokeWidth={2} />}</span>
          <span className="desktop-menu__label">{item.label}</span>
          {item.shortcut && <span className="desktop-menu__shortcut" aria-hidden="true">{item.shortcut}</span>}
        </button>)}
    </MenuPopup>
  }

  return <div className={`desktop-menu desktop-menu--${mode}`} ref={root}>
    <button ref={logo} type="button" className="desktop-menu__logo" aria-label="Lyrics Studio メニュー"
      title="Lyrics Studio メニュー (Alt+F10)" aria-haspopup="menu" aria-expanded={open?.source === 'logo'}
      aria-controls={open?.source === 'logo' ? `${prefix}-logo-menu` : undefined}
      onPointerDown={rememberContext}
      onClick={() => { if (open?.source === 'logo') close('logo'); else openLogo() }}
      onKeyDown={event => {
        if (ignoreKey(event)) return
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); openLogo(event.key === 'ArrowUp' ? groups.length - 1 : 0) }
        if (event.key === 'Escape') { event.preventDefault(); close('context') }
        if (event.key === 'Tab' && open) leaveWithTab(event)
      }}>
      <span className="desktop-menu__brand" aria-hidden="true"><Activity size={21} strokeWidth={2} /></span>
      <ChevronDown size={12} aria-hidden="true" />
    </button>
    {mode === 'bar' && <div role="menubar" aria-label="アプリケーションメニュー" className="desktop-menu__bar">
      {groups.map((group, index) => <button key={group.id} type="button" role="menuitem"
        id={triggerId('bar', index)} className="desktop-menu__top" tabIndex={index === Math.min(barIndex, groups.length - 1) ? 0 : -1}
        aria-haspopup="menu" aria-expanded={open?.source === 'bar' && open.groupId === group.id}
        aria-controls={open?.source === 'bar' && open.groupId === group.id ? panelId('bar', index) : undefined}
        ref={element => { if (element) barButtons.current.set(group.id, element); else barButtons.current.delete(group.id) }}
        onPointerDown={rememberContext}
        onFocus={() => setBarIndex(index)}
        onPointerEnter={event => { if (event.pointerType === 'mouse' && open?.source === 'bar' && open.groupId !== group.id) openBar(index, 'bar') }}
        onClick={() => { if (open?.source === 'bar' && open.groupId === group.id) { close(); focus(barButtons.current.get(group.id)) } else openBar(index) }}
        onKeyDown={event => barKey(event, index)}>{group.label}</button>)}
    </div>}
    {open && createPortal(<div ref={portal} className="desktop-menu__layer">
      {open.source === 'bar' && activeGroup && renderCommands(activeGroup, 'bar')}
      {open.source === 'logo' && <MenuPopup id={`${prefix}-logo-menu`} aria-label="Lyrics Studio メニュー" anchor={logo.current}>
        {groups.map((group, index) => <div key={group.id} role="none">
          <button type="button" role="menuitem" className="desktop-menu__category" id={triggerId('logo', index)} tabIndex={-1}
            aria-haspopup="menu" aria-expanded={open.groupId === group.id}
            aria-controls={open.groupId === group.id ? panelId('logo', index) : undefined}
            ref={element => { if (element) categoryButtons.current.set(group.id, element); else categoryButtons.current.delete(group.id) }}
            onPointerEnter={event => { if (event.pointerType === 'mouse') openCategory(index, false) }}
            onClick={() => openCategory(index)} onKeyDown={event => categoryKey(event, index)}>
            <span>{group.label}</span><ChevronRight size={14} aria-hidden="true" />
          </button>
          {open.groupId === group.id && renderCommands(group, 'logo')}
        </div>)}
      </MenuPopup>}
    </div>, document.body)}
  </div>
}
