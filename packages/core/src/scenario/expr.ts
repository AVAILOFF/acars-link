// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

/**
 * Condition expressions of scenarios (docs/05 `conditions`), without `eval`.
 *
 * ```
 * flight.minutes_to_tod >= 40
 * phase in ['PREFLIGHT', 'BOARDING'] and not (ofp.altn == null)
 * ```
 * Literals: numbers, 'strings' / "strings", true, false, null, [lists].
 * Operators: == != < <= > >= in, not in, and, or, not (also && || !), parentheses.
 * Ordering compares numbers only; anything else (null included) is false.
 */

export type Value = number | string | boolean | null | readonly Value[];

/** Resolves a dotted variable path; `undefined` = unknown variable. */
export type Lookup = (path: string) => Value | undefined;

export class ExprError extends Error {
  override readonly name = 'ExprError';
}

type Node =
  | { readonly k: 'lit'; readonly v: Value }
  | { readonly k: 'var'; readonly path: string }
  | { readonly k: 'list'; readonly items: readonly Node[] }
  | { readonly k: 'not'; readonly e: Node }
  | { readonly k: 'and' | 'or'; readonly a: Node; readonly b: Node }
  | { readonly k: 'cmp'; readonly op: CmpOp; readonly a: Node; readonly b: Node };

type CmpOp = '==' | '!=' | '<' | '<=' | '>' | '>=' | 'in' | 'not in';

interface Token {
  readonly t: 'num' | 'str' | 'id' | 'op' | 'end';
  readonly v: string;
  readonly pos: number;
}

const OPS = ['==', '!=', '<=', '>=', '&&', '||', '<', '>', '!', '(', ')', '[', ']', ','];

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const num = /^-?\d+(\.\d+)?/.exec(src.slice(i));
    const prev = out.at(-1);
    const unaryOk = prev === undefined || (prev.t === 'op' && prev.v !== ')' && prev.v !== ']');
    if (num !== null && (c !== '-' || unaryOk)) {
      out.push({ t: 'num', v: num[0], pos: i });
      i += num[0].length;
      continue;
    }
    if (c === "'" || c === '"') {
      const end = src.indexOf(c, i + 1);
      if (end < 0) throw new ExprError(`unterminated string at ${i}`);
      out.push({ t: 'str', v: src.slice(i + 1, end), pos: i });
      i = end + 1;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(src.slice(i));
    if (id !== null) {
      out.push({ t: 'id', v: id[0], pos: i });
      i += id[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op === undefined) throw new ExprError(`unexpected "${c}" at ${i}`);
    out.push({ t: 'op', v: op, pos: i });
    i += op.length;
  }
  out.push({ t: 'end', v: '', pos: src.length });
  return out;
}

class Parser {
  private i = 0;
  constructor(private readonly toks: Token[]) {}

  private peek(): Token {
    return this.toks[this.i] as Token;
  }
  private next(): Token {
    return this.toks[this.i++] as Token;
  }
  private isOp(v: string): boolean {
    const t = this.peek();
    return t.t === 'op' && t.v === v;
  }
  private isWord(v: string): boolean {
    const t = this.peek();
    return t.t === 'id' && t.v === v;
  }
  private expect(v: string): void {
    const t = this.next();
    if (t.t !== 'op' || t.v !== v) throw new ExprError(`expected "${v}" at ${t.pos}`);
  }

  parse(): Node {
    const e = this.or();
    const t = this.peek();
    if (t.t !== 'end') throw new ExprError(`unexpected "${t.v}" at ${t.pos}`);
    return e;
  }

  private or(): Node {
    let a = this.and();
    while (this.isWord('or') || this.isOp('||')) {
      this.next();
      a = { k: 'or', a, b: this.and() };
    }
    return a;
  }

  private and(): Node {
    let a = this.not();
    while (this.isWord('and') || this.isOp('&&')) {
      this.next();
      a = { k: 'and', a, b: this.not() };
    }
    return a;
  }

  private not(): Node {
    if (this.isWord('not') || this.isOp('!')) {
      this.next();
      return { k: 'not', e: this.not() };
    }
    return this.cmp();
  }

  private cmp(): Node {
    const a = this.primary();
    const t = this.peek();
    if (t.t === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(t.v)) {
      this.next();
      return { k: 'cmp', op: t.v as CmpOp, a, b: this.primary() };
    }
    if (this.isWord('in')) {
      this.next();
      return { k: 'cmp', op: 'in', a, b: this.primary() };
    }
    if (this.isWord('not') && this.toks[this.i + 1]?.v === 'in') {
      this.i += 2;
      return { k: 'cmp', op: 'not in', a, b: this.primary() };
    }
    return a;
  }

  private primary(): Node {
    const t = this.next();
    switch (t.t) {
      case 'num':
        return { k: 'lit', v: Number(t.v) };
      case 'str':
        return { k: 'lit', v: t.v };
      case 'id':
        if (t.v === 'true') return { k: 'lit', v: true };
        if (t.v === 'false') return { k: 'lit', v: false };
        if (t.v === 'null') return { k: 'lit', v: null };
        if (['and', 'or', 'not', 'in'].includes(t.v)) {
          throw new ExprError(`unexpected "${t.v}" at ${t.pos}`);
        }
        return { k: 'var', path: t.v };
      case 'op':
        if (t.v === '(') {
          const e = this.or();
          this.expect(')');
          return e;
        }
        if (t.v === '[') {
          const items: Node[] = [];
          if (!this.isOp(']')) {
            do items.push(this.primary());
            while (this.isOp(',') && this.next());
          }
          this.expect(']');
          return { k: 'list', items };
        }
        throw new ExprError(`unexpected "${t.v}" at ${t.pos}`);
      default:
        throw new ExprError('unexpected end of expression');
    }
  }
}

function evaluate(n: Node, look: Lookup): Value {
  switch (n.k) {
    case 'lit':
      return n.v;
    case 'var':
      return look(n.path) ?? null;
    case 'list':
      return n.items.map((x) => evaluate(x, look));
    case 'not':
      return !truthy(evaluate(n.e, look));
    case 'and':
      return truthy(evaluate(n.a, look)) && truthy(evaluate(n.b, look));
    case 'or':
      return truthy(evaluate(n.a, look)) || truthy(evaluate(n.b, look));
    case 'cmp': {
      const a = evaluate(n.a, look);
      const b = evaluate(n.b, look);
      switch (n.op) {
        case '==':
          return a === b;
        case '!=':
          return a !== b;
        case 'in':
          return Array.isArray(b) && b.includes(a);
        case 'not in':
          return Array.isArray(b) && !b.includes(a);
        default:
          if (typeof a !== 'number' || typeof b !== 'number') return false;
          if (n.op === '<') return a < b;
          if (n.op === '<=') return a <= b;
          if (n.op === '>') return a > b;
          return a >= b;
      }
    }
  }
}

const truthy = (v: Value): boolean => v !== null && v !== false && v !== 0 && v !== '';

function collectVars(n: Node, out: Set<string>): void {
  switch (n.k) {
    case 'var':
      out.add(n.path);
      return;
    case 'list':
      for (const x of n.items) collectVars(x, out);
      return;
    case 'not':
      collectVars(n.e, out);
      return;
    case 'lit':
      return;
    default:
      collectVars(n.a, out);
      collectVars(n.b, out);
  }
}

export interface CompiledExpr {
  readonly source: string;
  /** Variable paths the expression reads. */
  readonly vars: readonly string[];
  test(look: Lookup): boolean;
}

/** Parses once; throws {@link ExprError} with a position on bad syntax. */
export function compileExpr(source: string): CompiledExpr {
  let ast: Node;
  try {
    ast = new Parser(tokenize(source)).parse();
  } catch (e) {
    if (e instanceof ExprError) throw new ExprError(`${e.message} in "${source}"`);
    throw e;
  }
  const vars = new Set<string>();
  collectVars(ast, vars);
  return { source, vars: [...vars], test: (look) => truthy(evaluate(ast, look)) };
}
