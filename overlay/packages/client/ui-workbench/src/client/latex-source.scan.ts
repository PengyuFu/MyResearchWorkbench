/** Source-only LaTeX lexical operations. This does not expand TeX macros. */
import type { LatexRange } from './latex-source.types.ts'

export interface TexGroup extends LatexRange {
  contentFrom: number
  contentTo: number
}

export interface TexCommand extends LatexRange {
  name: string
}

export interface TexEnvironment extends LatexRange {
  name: string
  contentFrom: number
  contentTo: number
  nameEnd: number
}

/** Reads a control word or one escaped control symbol at an exact position. */
export function readTexCommand(source: string, from: number): TexCommand | null {
  if (source[from] !== '\\' || from + 1 >= source.length) return null
  const word = /^[A-Za-z@]+\*?/.exec(source.slice(from + 1))
  const name = word ? word[0] : source[from + 1]!
  const to = from + 1 + name.length
  return { name, from, to, raw: source.slice(from, to) }
}

/** Skips TeX whitespace and comments between command arguments. */
export function skipTexSpace(source: string, start: number, end = source.length): number {
  let at = start
  while (at < end) {
    if (/\s/.test(source[at]!)) { at++; continue }
    if (source[at] === '%') {
      const next = source.indexOf('\n', at)
      at = next < 0 ? end : Math.min(next + 1, end)
      continue
    }
    break
  }
  return at
}

/** Reads a balanced brace or optional bracket group, respecting escaped delimiters. */
export function readTexGroup(source: string, from: number, open = '{', close = '}'): TexGroup | null {
  if (source[from] !== open) return null
  let depth = 1
  let braces = 0
  let at = from + 1
  while (at < source.length) {
    const char = source[at]!
    if (char === '\\') { at = readTexCommand(source, at)?.to ?? at + 1; continue }
    if (char === '%') {
      const newline = source.indexOf('\n', at)
      at = newline < 0 ? source.length : newline + 1
      continue
    }
    if (open === '[' && char === '{') { braces++; at++; continue }
    if (open === '[' && char === '}' && braces > 0) { braces--; at++; continue }
    if (braces === 0 && char === open) depth++
    if (braces === 0 && char === close && --depth === 0) {
      return { from, to: at + 1, raw: source.slice(from, at + 1), contentFrom: from + 1, contentTo: at }
    }
    at++
  }
  return null
}

/** Reads one braced argument following whitespace and optional arguments. */
export function requiredTexGroup(source: string, from: number): TexGroup | null {
  let at = skipTexSpace(source, from)
  while (source[at] === '[') {
    const option = readTexGroup(source, at, '[', ']')
    if (!option) return null
    at = skipTexSpace(source, option.to)
  }
  return readTexGroup(source, at)
}

/** Finds the matching end of a nested environment without rewriting its contents. */
export function readTexEnvironment(source: string, from: number): TexEnvironment | null {
  const command = readTexCommand(source, from)
  if (!command || command.name !== 'begin') return null
  const name = readTexGroup(source, skipTexSpace(source, command.to))
  if (!name) return null
  const envName = source.slice(name.contentFrom, name.contentTo)
  const stack = [envName]
  let at = name.to
  while (at < source.length) {
    if (source[at] === '%') {
      const newline = source.indexOf('\n', at)
      at = newline < 0 ? source.length : newline + 1
      continue
    }
    if (source[at] !== '\\') { at++; continue }
    const token = readTexCommand(source, at)
    if (!token) { at++; continue }
    if (token.name !== 'begin' && token.name !== 'end') { at = token.to; continue }
    const group = readTexGroup(source, skipTexSpace(source, token.to))
    if (!group) { at = token.to; continue }
    const value = source.slice(group.contentFrom, group.contentTo)
    if (token.name === 'begin') stack.push(value)
    else {
      if (value !== stack[stack.length - 1]) return null
      stack.pop()
      if (!stack.length) return { from, to: group.to, raw: source.slice(from, group.to), name: envName, nameEnd: name.to, contentFrom: name.to, contentTo: at }
    }
    at = group.to
  }
  return null
}

/** Iterates actual control sequences, excluding comments and escaped backslashes. */
export function texCommands(source: string, from = 0, to = source.length): TexCommand[] {
  const result: TexCommand[] = []
  let at = from
  while (at < to) {
    if (source[at] === '%') { const nl = source.indexOf('\n', at); at = nl < 0 ? to : nl + 1; continue }
    if (source[at] !== '\\') { at++; continue }
    const token = readTexCommand(source, at)
    if (!token) { at++; continue }
    result.push(token)
    at = token.to
  }
  return result
}

/** Removes only surrounding whitespace from a source interval. */
export function trimTexRange(source: string, from: number, to: number): { from: number; to: number } {
  while (from < to && /\s/.test(source[from]!)) from++
  while (to > from && /\s/.test(source[to - 1]!)) to--
  return { from, to }
}
