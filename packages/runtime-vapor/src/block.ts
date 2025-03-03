import { isArray } from '@vue/shared'
import {
  type VaporComponentInstance,
  isVaporComponent,
  mountComponent,
  unmountComponent,
} from './component'
import { createComment, createTextNode } from './dom/node'
import { EffectScope, pauseTracking, resetTracking } from '@vue/reactivity'
import {
  type TransitionHooks,
  type TransitionProps,
  type TransitionState,
  performTransitionEnter,
  performTransitionLeave,
} from '@vue/runtime-dom'
import {
  applyTransitionEnterHooks,
  applyTransitionLeaveHooks,
} from './components/Transition'

export type Block = (
  | Node
  | VaporFragment
  | DynamicFragment
  | VaporComponentInstance
  | Block[]
) &
  TransitionBlock

export interface VaporTransitionHooks extends TransitionHooks {
  state?: TransitionState
  props?: TransitionProps
}

export type TransitionBlock = {
  key?: any
  transition?: VaporTransitionHooks
}

export type BlockFn = (...args: any[]) => Block

export class VaporFragment {
  nodes: Block
  anchor?: Node
  insert?: (parent: ParentNode, anchor: Node | null) => void
  remove?: (parent?: ParentNode) => void
  transitionChild?: TransitionBlock | undefined

  constructor(nodes: Block) {
    this.nodes = nodes
  }
}

export class DynamicFragment extends VaporFragment {
  anchor: Node
  scope: EffectScope | undefined
  current?: BlockFn
  fallback?: BlockFn
  transitionChild?: Block

  constructor(anchorLabel?: string) {
    super([])
    this.anchor =
      __DEV__ && anchorLabel ? createComment(anchorLabel) : createTextNode()
  }

  update(render?: BlockFn, key: any = render): void {
    if (key === this.current) {
      return
    }
    this.current = key

    pauseTracking()
    const parent = this.anchor.parentNode

    const renderBranch = () => {
      if (render) {
        const transition = this.transition
        this.scope = new EffectScope()
        this.nodes = this.scope.run(render) || []
        if (transition) {
          this.transitionChild = applyTransitionEnterHooks(
            this.nodes,
            transition.state!,
            transition.props!,
            transition,
          )
        }
        if (parent) insert(this.nodes, parent, this.anchor)
      } else {
        this.scope = undefined
        this.nodes = []
      }
    }

    // teardown previous branch
    if (this.scope) {
      this.scope.stop()
      const mode = this.transition && this.transition.mode
      if (mode) {
        applyTransitionLeaveHooks(
          this.nodes,
          this.transition!.state!,
          this.transition!.props!,
          renderBranch,
          this.transition,
        )
        parent && remove(this.nodes, parent)
        if (mode === 'out-in') {
          resetTracking()
          return
        }
      } else {
        parent && remove(this.nodes, parent)
      }
    }

    renderBranch()

    if (this.fallback && !isValidBlock(this.nodes)) {
      parent && remove(this.nodes, parent)
      this.nodes =
        (this.scope || (this.scope = new EffectScope())).run(this.fallback) ||
        []
      parent && insert(this.nodes, parent, this.anchor)
    }

    resetTracking()
  }

  get transition(): VaporTransitionHooks | undefined {
    return this.transitionChild && this.transitionChild.transition
  }
}

export function isFragment(val: NonNullable<unknown>): val is VaporFragment {
  return val instanceof VaporFragment
}

export function isBlock(val: NonNullable<unknown>): val is Block {
  return (
    val instanceof Node ||
    isArray(val) ||
    isVaporComponent(val) ||
    isFragment(val)
  )
}

export function isValidBlock(block: Block): boolean {
  if (block instanceof Node) {
    return !(block instanceof Comment)
  } else if (isVaporComponent(block)) {
    return isValidBlock(block.block)
  } else if (isArray(block)) {
    return block.length > 0 && block.every(isValidBlock)
  } else {
    // fragment
    return isValidBlock(block.nodes)
  }
}

export function insert(
  block: Block,
  parent: ParentNode,
  anchor: Node | null | 0 = null, // 0 means prepend
  parentSuspense?: any, // TODO Suspense
): void {
  anchor = anchor === 0 ? parent.firstChild : anchor
  if (block instanceof Node) {
    // don't apply transition on text or comment nodes
    if (block.transition && block instanceof Element) {
      performTransitionEnter(
        block,
        // @ts-expect-error
        block.transition,
        () => parent.insertBefore(block, anchor),
        parentSuspense,
      )
    } else {
      parent.insertBefore(block, anchor)
    }
  } else if (isVaporComponent(block)) {
    mountComponent(block, parent, anchor)
  } else if (isArray(block)) {
    for (let i = 0; i < block.length; i++) {
      insert(block[i], parent, anchor)
    }
  } else {
    // fragment
    if (block.insert) {
      block.insert(parent, anchor)
    } else {
      insert(block.nodes, parent, anchor, parentSuspense)
    }
    if (block.anchor) insert(block.anchor, parent, anchor)
  }
}

export function prepend(parent: ParentNode, ...blocks: Block[]): void {
  let i = blocks.length
  while (i--) insert(blocks[i], parent, 0)
}

export function remove(block: Block, parent?: ParentNode): void {
  if (block instanceof Node) {
    if (block.transition && block instanceof Element) {
      performTransitionLeave(
        block,
        // @ts-expect-error
        block.transition,
        () => parent && parent.removeChild(block),
      )
    } else {
      parent && parent.removeChild(block)
    }
  } else if (isVaporComponent(block)) {
    unmountComponent(block, parent)
  } else if (isArray(block)) {
    for (let i = 0; i < block.length; i++) {
      remove(block[i], parent)
    }
  } else {
    // fragment
    if (block.remove) {
      block.remove(parent)
    } else {
      remove(block.nodes, parent)
    }
    if (block.anchor) remove(block.anchor, parent)
    if ((block as DynamicFragment).scope) {
      ;(block as DynamicFragment).scope!.stop()
    }
  }
}

/**
 * dev / test only
 */
export function normalizeBlock(block: Block): Node[] {
  if (!__DEV__ && !__TEST__) {
    throw new Error(
      'normalizeBlock should not be used in production code paths',
    )
  }
  const nodes: Node[] = []
  if (block instanceof Node) {
    nodes.push(block)
  } else if (isArray(block)) {
    block.forEach(child => nodes.push(...normalizeBlock(child)))
  } else if (isVaporComponent(block)) {
    nodes.push(...normalizeBlock(block.block!))
  } else {
    nodes.push(...normalizeBlock(block.nodes))
    block.anchor && nodes.push(block.anchor)
  }
  return nodes
}
