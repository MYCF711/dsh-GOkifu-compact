/**
 * undefined-ref-audit.mjs —— 找出「被引用 / 被 export，但从未 import 或声明」的标识符（C651）
 *
 * 由来：`scripts/session-scan.mjs` 曾有 `export { decodeMultiFrameZstd } from "…"`
 * （**纯转发，不建本地绑定**），而 `main()` 自己调用了它 ⇒ CLI 一跑就
 * `ReferenceError: decodeMultiFrameZstd is not defined`。1260 条测试全绿也拦不住，
 * 因为测试 `import` 走的是 re-export（能拿到），只有 `main()` 那条路径才炸。
 *
 * 为什么不正则猜：字符串、注释、模板、正则字面量里都有括号和冒号，正则扫出来的"标识符"
 * 大半不是标识符（还会把中文注释读成代码，产出 `，占` 这种"名字"）。这里**真做词法分析**：
 * 注释 / 字符串 / 模板 / 正则 / 数字 / 标点按状态机切，再按「位置是否是可求值引用」判定，
 * 最后与**模块级绑定集合**对比。
 *
 * 判定（保守策略：宁可漏报，不制造噪音）：
 *   ① 标识符若在**本文件任何位置**被绑定过（import / function / class / var / let / const /
 *      函数参数 / 箭头参数 / 方法参数 / catch 参数 / 解构模式）⇒ 永不报告；
 *   ② 只在「值引用位置」才算引用（`a.b` 的 b、`{k: 1}` 的 k、方法名、标签、`#私有名` 都不算）；
 *   ③ 剩下还不属于 JS 关键字 / 运行时全局 / 语境关键字的 ⇒ 报告。
 *
 * 两类问题：
 *   K1 `free-identifier`：读了但全文件没绑定过 ⇒ 运行到那行必 ReferenceError（本 bug 就是这类）。
 *   K2 `export-unbound`：`export { X }`（**不带 from**）而 X 没有本地绑定 ⇒ 链接期 SyntaxError。
 *
 * **已知覆盖边界**（诚实声明，不装作全知）：
 *   - 模板字面量整体当字符串，`${ … }` 里的名字**不检查**（避免状态机被嵌套反引号带偏）；
 *   - 只做"模块级绑定"，不做精确作用域：名字在别的块里声明过就算有绑定 ⇒ **会漏报**；
 *   - 动态属性名 / `with` / `eval` 造出来的名字一律看不见。
 *   所以本工具的结论是「清扫 + 守门」，不是"证明没有 bug"。
 *
 * 用法：
 *   node scripts/undefined-ref-audit.mjs              # 扫 scripts 与 src 下的全部 .mjs
 *   node scripts/undefined-ref-audit.mjs --root <dir> # 扫任意目录（自证用：已知坏的夹具）
 *   node scripts/undefined-ref-audit.mjs --json
 *   node scripts/undefined-ref-audit.mjs --self-test  # 内置已知坏/已知好夹具，自证能红能绿
 *
 * 退出码：0 = 干净；1 = 有发现；2 = 自证失败（扫描器坏了，不许当成绿）。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");

// ───────────────────────────── 关键字 / 全局 ─────────────────────────────

/** JS 保留字（永远不是"值引用"）。 */
const RESERVED = new Set([
  "await", "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete",
  "do", "else", "enum", "export", "extends", "false", "finally", "for", "function", "if", "import",
  "in", "instanceof", "new", "null", "return", "super", "switch", "this", "throw", "true", "try",
  "typeof", "var", "void", "while", "with", "yield",
]);

/** 语境关键字：在特定位置是名字（`get foo(){}` / `from` / `as`），一律不当值引用。 */
const CONTEXTUAL = new Set([
  "as", "assert", "async", "constructor", "from", "get", "let", "meta", "of", "set", "static", "target",
]);

/** 运行时全局（Node + Web），未声明也不算错。 */
const GLOBALS = new Set([
  "AbortController", "AbortSignal", "AggregateError", "Array", "ArrayBuffer", "Atomics", "BigInt",
  "BigInt64Array", "BigUint64Array", "Boolean", "Buffer", "DataView", "Date", "decodeURI",
  "decodeURIComponent", "encodeURI", "encodeURIComponent", "Error", "EvalError", "FinalizationRegistry",
  "Float32Array", "Float64Array", "Function", "Infinity", "Int16Array", "Int32Array", "Int8Array",
  "Intl", "Iterator", "JSON", "Map", "Math", "NaN", "Number", "Object", "Promise", "Proxy",
  "RangeError", "ReferenceError", "Reflect", "RegExp", "Set", "SharedArrayBuffer", "String", "Symbol",
  "SyntaxError", "TextDecoder", "TextEncoder", "TypeError", "URIError", "URL", "URLSearchParams",
  "Uint16Array", "Uint32Array", "Uint8Array", "Uint8ClampedArray", "WeakMap", "WeakRef", "WeakSet",
  "WebAssembly", "arguments", "atob", "btoa", "clearImmediate", "clearInterval", "clearTimeout",
  "console", "crypto", "eval", "fetch", "global", "globalThis", "isFinite", "isNaN", "performance",
  "process", "queueMicrotask", "setImmediate", "setInterval", "setTimeout", "structuredClone",
  "undefined", "require", "module", "exports", "__dirname", "__filename",
]);

// ───────────────────────────── 词法分析器 ─────────────────────────────

const PUNCTUATORS = [
  ">>>=", "**=", "===", "!==", ">>>", "<<=", ">>=", "...", "=>", "==", "!=", "<=", ">=", "&&=", "||=",
  "??=", "**", "++", "--", "<<", ">>", "&&", "||", "??", "?.", "+=", "-=", "*=", "/=", "%=", "&=",
  "|=", "^=", "::",
];
const SINGLE_PUNCT = "{}()[];,<>+-*/%&|^!~?:=.@#";

const isIdStart = (c) => /[A-Za-z_$]/.test(c) || (c > "\u007f" && /[\p{L}\p{Nl}]/u.test(c));
const isIdPart = (c) => /[A-Za-z0-9_$]/.test(c) || (c > "\u007f" && /[\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}]/u.test(c));

/**
 * 真词法分析：返回 token 序列（注释、空白丢弃）。
 * token = { type, value, line, col, start }
 * type ∈ ident | punct | num | str | template | regex
 */
export function tokenize(src) {
  const toks = [];
  const n = src.length;
  let i = 0;
  let line = 1;
  let col = 1;

  const advance = (count) => {
    for (let k = 0; k < count && i < n; k += 1) {
      if (src[i] === "\n") {
        line += 1;
        col = 1;
      } else {
        col += 1;
      }
      i += 1;
    }
  };
  const push = (type, value, startLine, startCol, start) =>
    toks.push({ type, value, line: startLine, col: startCol, start });

  // `{` 种类栈：只用来判断 `}` 之后能不能起一个正则字面量。
  const braceKinds = [];

  const regexAllowed = () => {
    const prev = toks[toks.length - 1];
    if (!prev) return true;
    if (prev.type === "num" || prev.type === "str" || prev.type === "template" || prev.type === "regex") return false;
    if (prev.type === "ident") {
      if (CONTEXTUAL.has(prev.value)) return false; // `of /re/` 不会出现；`x` 后面是除号
      return RESERVED.has(prev.value) && prev.value !== "this" && prev.value !== "super" && prev.value !== "null" &&
        prev.value !== "true" && prev.value !== "false";
    }
    if (prev.type === "punct") {
      if (prev.value === ")" || prev.value === "]" || prev.value === "++" || prev.value === "--") return false;
      if (prev.value === "}") return braceKinds[braceKinds.length - 1] === "block";
      return true;
    }
    return true;
  };

  // `#!` 行（shebang）：整行跳过，否则 `env` / `node` 会被当成两个未定义标识符
  if (src.startsWith("#!")) {
    while (i < n && src[i] !== "\n") advance(1);
  }

  // 模式栈：code / template。模板里的 `${ … }` 会 push 一个 code 模式（可再嵌套模板），
  // 这样 `` `${a ? `${b}` : c}` `` 这种嵌套不会把状态机切断。
  const modes = [{ kind: "code", braceDepth: 0 }];
  const topMode = () => modes[modes.length - 1];

  while (i < n) {
    const mode = topMode();
    const c = src[i];

    if (mode.kind === "template") {
      if (c === "\\") {
        advance(2);
        continue;
      }
      if (c === "`") {
        advance(1);
        modes.pop();
        continue;
      }
      if (c === "$" && src[i + 1] === "{") {
        advance(2);
        modes.push({ kind: "code", braceDepth: 1, templateExpr: true });
        continue;
      }
      advance(1);
      continue;
    }

    if (c === "}" && mode.templateExpr) {
      if (mode.braceDepth === 1) {
        advance(1);
        modes.pop(); // 回到模板块
        continue;
      }
      mode.braceDepth -= 1;
      // 继续走下面的标点处理（`${ {a:1} }` 里的对象字面量）
    }

    if (c === "\n" || c === "\r" || c === " " || c === "\t" || c === "\f" || c === "\v" || c === "\u00a0" || c === "\ufeff") {
      advance(1);
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") advance(1);
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      advance(2);
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) advance(1);
      advance(2);
      continue;
    }
    // 模板字面量：进入 template 模式，`${…}` 内部按代码扫描
    if (c === "`") {
      const startLine = line;
      const startCol = col;
      advance(1);
      push("template", "", startLine, startCol, i - 1);
      modes.push({ kind: "template" });
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      const startLine = line;
      const startCol = col;
      const start = i;
      advance(1);
      while (i < n && src[i] !== quote && src[i] !== "\n") {
        if (src[i] === "\\") advance(2);
        else advance(1);
      }
      if (i < n && src[i] === quote) advance(1);
      push("str", src.slice(start, i), startLine, startCol, start);
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const startLine = line;
      const startCol = col;
      const start = i;
      while (i < n) {
        const d = src[i];
        if (/[0-9a-fA-FxXoObBeE._]/.test(d)) {
          advance(1);
          continue;
        }
        // 指数符号只在前一位是 e/E 且前面还是数字时吃进来
        if ((d === "+" || d === "-") && /[eE]/.test(src[i - 1] ?? "")) {
          advance(1);
          continue;
        }
        break;
      }
      push("num", src.slice(start, i), startLine, startCol, start);
      continue;
    }
    if (isIdStart(c)) {
      const startLine = line;
      const startCol = col;
      const start = i;
      advance(1);
      while (i < n && isIdPart(src[i])) advance(1);
      push("ident", src.slice(start, i), startLine, startCol, start);
      continue;
    }
    // 正则字面量：匹配失败（本行内找不到收尾 `/`）就**回退**，当成除号 —— 否则会吞掉整段真正代码
    if (c === "/" && regexAllowed()) {
      const startLine = line;
      const startCol = col;
      const start = i;
      let k = i + 1;
      let inClass = false;
      let ok = false;
      while (k < n) {
        const d = src[k];
        if (d === "\\") {
          k += 2;
          continue;
        }
        if (d === "\n") break;
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) {
          ok = true;
          k += 1;
          break;
        }
        k += 1;
      }
      if (ok) {
        while (k < n && /[a-z]/.test(src[k])) k += 1;
        advance(k - i);
        push("regex", src.slice(start, i), startLine, startCol, start);
        continue;
      }
      // 回退成除号
    }
    let matched = null;
    for (const p of PUNCTUATORS) {
      if (src.startsWith(p, i)) {
        matched = p;
        break;
      }
    }
    if (matched === null && SINGLE_PUNCT.includes(c)) matched = c;
    if (matched === null) {
      advance(1); // 未知字符（全角符号等）直接吞掉，不让它卡住
      continue;
    }
    const startLine = line;
    const startCol = col;
    advance(matched.length);
    push("punct", matched, startLine, startCol, i - matched.length);

    if (matched === "{") {
      if (mode.templateExpr) mode.braceDepth += 1;
      const prev = toks.length >= 2 ? toks[toks.length - 2] : null;
      let kind = "object";
      if (prev === null) kind = "block";
      else if (prev.type === "punct") {
        if (prev.value === ")" || prev.value === "=>" || prev.value === ";" || prev.value === "{" || prev.value === "}") kind = "block";
        else kind = "object";
      } else if (prev.type === "ident") {
        if (prev.value === "else" || prev.value === "try" || prev.value === "finally" || prev.value === "do") kind = "block";
        else if (prev.value === "return") kind = "object";
        else if (prev.value === "class") kind = "class";
        else kind = "block"; // `foo(…) {` 方法体 / `switch (x) {` / `class A {`
      } else {
        kind = "object";
      }
      braceKinds.push(kind);
    } else if (matched === "}") {
      if (braceKinds.length > 0) braceKinds.pop();
    }
  }

  return toks;
}

// ───────────────────────────── 绑定收集 ─────────────────────────────

const tokAt = (toks, idx) => toks[idx] ?? null;

/**
 * 收集"本文件任何位置被绑定过"的名字集合。
 * 故意**过收集**（`{a: b}` 的 a 也收）：这只可能导致漏报，不会制造噪音。
 */
function collectBindings(toks) {
  const bound = new Set();
  const add = (t) => {
    if (t && t.type === "ident") bound.add(t.value);
  };

  /** 从 `(` 开始，把配对 `)` 之间的标识符全收下；返回配对 `)` 的下标。 */
  const bindParams = (openIdx) => {
    let depth = 0;
    let k = openIdx;
    for (; k < toks.length; k += 1) {
      const tk = toks[k];
      if (tk.type !== "punct") continue;
      if (tk.value === "(" || tk.value === "[" || tk.value === "{") depth += 1;
      else if (tk.value === ")" || tk.value === "]" || tk.value === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    for (let j = openIdx + 1; j < k; j += 1) add(toks[j]);
    return k;
  };

  for (let idx = 0; idx < toks.length; idx += 1) {
    const tk = toks[idx];

    // ── 标点：箭头函数 / 方法体的参数表 ──
    if (tk.type === "punct") {
      if (tk.value === "=>") {
        const left = tokAt(toks, idx - 1);
        if (left && left.type === "ident" && !RESERVED.has(left.value)) add(left);
        else if (left && left.type === "punct" && left.value === ")") {
          let depth = 0;
          for (let k = idx - 1; k >= 0; k -= 1) {
            const t2 = toks[k];
            if (t2.type !== "punct") continue;
            if (t2.value === ")") depth += 1;
            else if (t2.value === "(") {
              depth -= 1;
              if (depth === 0) {
                bindParams(k);
                break;
              }
            }
          }
        }
        continue;
      }
      if (tk.value === "(") {
        const close = (() => {
          let depth = 0;
          for (let k = idx; k < toks.length; k += 1) {
            const t2 = toks[k];
            if (t2.type !== "punct") continue;
            if (t2.value === "(" || t2.value === "[" || t2.value === "{") depth += 1;
            else if (t2.value === ")" || t2.value === "]" || t2.value === "}") {
              depth -= 1;
              if (depth === 0) return k;
            }
          }
          return -1;
        })();
        const after = close >= 0 ? tokAt(toks, close + 1) : null;
        // `( … ) {` ⇒ 方法/函数体；`( … ) =>` ⇒ 箭头。两种情况括号里都是参数（过收集无害）
        if (after && (after.type === "punct" && (after.value === "{" || after.value === "=>"))) bindParams(idx);
      }
      continue;
    }

    if (tk.type !== "ident") continue;

    // ── import 子句 ──
    if (tk.value === "import") {
      const next = tokAt(toks, idx + 1);
      if (next && next.type === "punct" && (next.value === "." || next.value === "(")) continue;
      for (let k = idx + 1; k < toks.length; k += 1) {
        const t2 = toks[k];
        if (t2.type === "punct" && t2.value === ";") break;
        if (t2.type === "ident" && t2.value === "from") break;
        if (t2.type === "str") break; // import "m"
        add(t2); // `{ a as b }` 的 a 与 b 都收（过收集）
      }
      continue;
    }

    // ── 函数名 / 类名（函数连参数一起） ──
    if (tk.value === "function" || tk.value === "class") {
      let k = idx + 1;
      if (toks[k] && toks[k].type === "punct" && toks[k].value === "*") k += 1;
      const nameTok = toks[k];
      if (nameTok && nameTok.type === "ident" && !RESERVED.has(nameTok.value)) add(nameTok);
      if (tk.value === "function") {
        let j = k;
        while (j < toks.length) {
          const t2 = toks[j];
          if (t2.type === "punct" && t2.value === "(") {
            bindParams(j);
            break;
          }
          if (t2.type === "punct" && (t2.value === "{" || t2.value === ";")) break;
          j += 1;
        }
      }
      continue;
    }

    // ── 声明式绑定：const / let / var ──
    // ★ 这里最容易出假阴性：初始化表达式必须**跳过**，而且跳过之后必须**退出声明**。
    //   旧写法跳过 `=` 后继续用外层 for 扫全文件 ⇒ 把后面每个标识符都当"已声明"，
    //   连带把本文件第 116 行的 decodeMultiFrameZstd 也吞了（扫描器自己反而变绿）。
    if (tk.value === "const" || tk.value === "let" || tk.value === "var") {
      let depth = 0;
      let k = idx + 1;
      decl: while (k < toks.length) {
        const t2 = toks[k];
        if (t2.type === "punct") {
          if (t2.value === "(" || t2.value === "[" || t2.value === "{") {
            depth += 1;
            k += 1;
            continue;
          }
          if (t2.value === ")" || t2.value === "]" || t2.value === "}") {
            if (depth === 0) break decl; // 声明结束（for-of 的 `)` / 块收尾）
            depth -= 1;
            k += 1;
            continue;
          }
          if (t2.value === ";") break decl;
          if (t2.value === "=" && depth === 0) {
            // 跳过初始化表达式：停在同层 `,`（下一个 declarator）/ `;` / 收尾括号
            let d2 = 0;
            k += 1;
            while (k < toks.length) {
              const t3 = toks[k];
              if (t3.type === "punct") {
                if (t3.value === "(" || t3.value === "[" || t3.value === "{") {
                  d2 += 1;
                  k += 1;
                  continue;
                }
                if (t3.value === ")" || t3.value === "]" || t3.value === "}") {
                  if (d2 === 0) break;
                  d2 -= 1;
                  k += 1;
                  continue;
                }
                if ((t3.value === "," || t3.value === ";") && d2 === 0) break;
              } else if (t3.type === "ident" && d2 === 0 &&
                (t3.value === "const" || t3.value === "let" || t3.value === "var" || t3.value === "function" ||
                  t3.value === "class" || t3.value === "export" || t3.value === "import" || t3.value === "return")) {
                break; // 无分号风格：下一句已经开始，别再往下吞
              }
              k += 1;
            }
            if (k < toks.length && toks[k].type === "punct" && toks[k].value === ",") {
              k += 1; // 还有下一个 declarator
              continue;
            }
            break decl;
          }
          k += 1;
          continue;
        }
        if (t2.type === "ident" && (t2.value === "of" || t2.value === "in")) break decl;
        add(t2);
        k += 1;
      }
      continue;
    }

    // ── catch 参数 ──
    if (tk.value === "catch") {
      const next = tokAt(toks, idx + 1);
      if (next && next.type === "punct" && next.value === "(") bindParams(idx + 1);
      continue;
    }
  }
  return bound;
}

// ───────────────────────────── 引用判定 ─────────────────────────────

/**
 * 该 identifier token 是否处在"值引用"位置。
 * 返回 false ⇒ 属性名 / 键 / 方法名 / 标签 / 私有名，不算引用。
 */
function isValueReference(toks, idx) {
  const prev = tokAt(toks, idx - 1);
  const next = tokAt(toks, idx + 1);
  if (!prev) return true;

  // a.b / a?.b / import.meta / this.#x
  if (prev.type === "punct" && (prev.value === "." || prev.value === "?.")) return false;
  if (prev.type === "punct" && prev.value === "#") return false;

  // 标签：`label:` 与 `break label` / `continue label`（标签不是变量）
  if (prev.type === "ident" && (prev.value === "break" || prev.value === "continue")) return false;

  // 对象字面量 / 解构模式里的 `key:`（三元 `a ? b : c` 不受影响：prev 是 `?`）
  if (next && next.type === "punct" && next.value === ":") {
    if (prev.type === "punct" && (prev.value === "{" || prev.value === "," || prev.value === ";" || prev.value === "}" || prev.value === "(" || prev.value === "[")) return false;
    if (prev.type === "ident" && (prev.value === "get" || prev.value === "set" || prev.value === "async" || prev.value === "static" || prev.value === "case" || prev.value === "default")) return false;
  }

  // 成员/键边界（`{` `,` `;` `}` 之后）
  const atMemberBoundary = prev.type === "punct" && (prev.value === "{" || prev.value === "," || prev.value === ";" || prev.value === "}");

  // 方法定义名：`{ foo() {} }` / `class A { foo() {} }`
  if (atMemberBoundary && next && next.type === "punct" && next.value === "(") return false;
  // `get foo()` / `set foo()` / `static foo()` / `async foo()` / `*foo()`
  if (prev.type === "ident" && (prev.value === "get" || prev.value === "set" || prev.value === "static" || prev.value === "async")) return false;
  if (prev.type === "punct" && prev.value === "*") return false;
  // 类字段：`foo = 1;`（同样只在成员边界）
  if (atMemberBoundary && next && next.type === "punct" && next.value === "=") return false;

  return true;
}

/**
 * 分析一段源码，返回发现。
 * @param {string} src
 * @param {string} file
 */
export function analyzeSource(src, file = "<inline>") {
  const toks = tokenize(src);
  const bound = collectBindings(toks);
  const findings = [];
  const seen = new Set();

  for (let idx = 0; idx < toks.length; idx += 1) {
    const tk = toks[idx];
    if (tk.type !== "ident") continue;
    if (RESERVED.has(tk.value) || CONTEXTUAL.has(tk.value) || GLOBALS.has(tk.value)) continue;
    if (bound.has(tk.value)) continue;
    if (!isValueReference(toks, idx)) continue;
    const key = `K1:${tk.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({
      file,
      name: tk.value,
      line: tk.line,
      col: tk.col,
      kind: "free-identifier",
      detail: "被引用但全文件没有 import / 声明 ⇒ 运行到这行会 ReferenceError",
    });
  }

  // K2：`export { X }`（不带 from）而 X 没本地绑定 ⇒ 链接期语法错误
  for (let idx = 0; idx < toks.length; idx += 1) {
    const tk = toks[idx];
    if (tk.type !== "ident" || tk.value !== "export") continue;
    const next = tokAt(toks, idx + 1);
    if (!next || next.type !== "punct" || next.value !== "{") continue;
    let depth = 0;
    let closeIdx = -1;
    for (let k = idx + 1; k < toks.length; k += 1) {
      const t2 = toks[k];
      if (t2.type !== "punct") continue;
      if (t2.value === "{") depth += 1;
      else if (t2.value === "}") {
        depth -= 1;
        if (depth === 0) {
          closeIdx = k;
          break;
        }
      }
    }
    if (closeIdx < 0) continue;
    // `from` 在 `}` **之后**：`export { A } from "…"` 的 from 不在花括号内
    const after = tokAt(toks, closeIdx + 1);
    if (after && after.type === "ident" && after.value === "from") continue;

    let expectName = true;
    for (let j = idx + 2; j < closeIdx; j += 1) {
      const t2 = toks[j];
      if (t2.type === "punct" && t2.value === ",") {
        expectName = true;
        continue;
      }
      if (t2.type !== "ident") continue;
      if (!expectName) continue; // `as C` 的别名（C 是本地名，不参与本检查）
      expectName = false;
      if (RESERVED.has(t2.value) || CONTEXTUAL.has(t2.value)) continue;
      if (bound.has(t2.value)) continue;
      const key = `K2:${t2.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        file,
        name: t2.value,
        line: t2.line,
        col: t2.col,
        kind: "export-unbound",
        detail: "`export { X }` 不带 from，而 X 没有本地绑定 ⇒ 链接期 SyntaxError",
      });
    }
  }

  return { findings };
}

// ───────────────────────────── 扫描器 ─────────────────────────────

/** 收集目标文件：默认 scripts/*.mjs 与 src 下全部 .mjs。 */
export function listTargets(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = nodeFs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = nodePath.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        walk(full);
      } else if (e.name.endsWith(".mjs") && !e.name.startsWith(".")) {
        // 跳过 `.engine-under-test*.mjs` 这类测试期临时变异副本（它们是故意注错的拷贝）
        out.push(full);
      }
    }
  };
  const scriptsDir = nodePath.join(root, "scripts");
  const srcDir = nodePath.join(root, "src");
  if (nodeFs.existsSync(scriptsDir)) {
    for (const e of nodeFs.readdirSync(scriptsDir)) {
      if (e.endsWith(".mjs")) out.push(nodePath.join(scriptsDir, e));
    }
  }
  if (nodeFs.existsSync(srcDir)) walk(srcDir);
  return out.sort();
}

/**
 * 扫描并返回结果。
 * @param {string} root
 */
export function audit(root = ROOT) {
  const targets = listTargets(root);
  const files = [];
  const findings = [];
  const errors = [];
  for (const full of targets) {
    let src;
    try {
      src = nodeFs.readFileSync(full, "utf8");
    } catch (error) {
      errors.push({ file: full, error: String(error?.message ?? error) });
      continue;
    }
    const rel = nodePath.relative(root, full).split(nodePath.sep).join("/");
    let result;
    try {
      result = analyzeSource(src, rel);
    } catch (error) {
      errors.push({ file: rel, error: String(error?.message ?? error) });
      continue;
    }
    files.push({ file: rel, findings: result.findings });
    findings.push(...result.findings);
  }
  return { root, files, findings, scanned: targets.length, errors };
}

// ───────────────────────────── 自证夹具 ─────────────────────────────

/** 已知坏：纯转发 + 本地调用（就是 session-scan 那个 bug 的最小复现）。 */
const FIXTURE_BAD = [
  'export { decodeMultiFrameZstd } from "../src/rooms/zstd-log.mjs";',
  "",
  "export function main(argv) {",
  "  const { text } = decodeMultiFrameZstd(Buffer.from(argv));",
  "  return text;",
  "}",
].join("\n");

/** 已知好：同样的代码，只把纯转发改成 import + export。 */
const FIXTURE_GOOD = [
  'import { decodeMultiFrameZstd } from "../src/rooms/zstd-log.mjs";',
  "export { decodeMultiFrameZstd };",
  "",
  "export function main(argv) {",
  "  const { text } = decodeMultiFrameZstd(Buffer.from(argv));",
  "  return text;",
  "}",
].join("\n");

/** 一个"看起来像坏、其实不坏"的夹具：属性名 / 键 / 方法名 / 私有名 / 标签都不是引用。 */
const FIXTURE_LOOKALIKE = [
  "export function shape(obj, name) {",
  "  const { a, b: renamed } = obj;",
  "  const o = { key: a, shorthand: renamed, get late() { return 1; } };",
  "  const f = (p, q = 2) => p + q + o.key;",
  '  const s = "not_a_ref(key: value)";',
  "  const t = `still ${a} not_a_ref`;",
  "  outer: for (const x of [a]) { if (x) break outer; }",
  "  return [f, s, t, name, typeof obj];",
  "}",
].join("\n");

/**
 * 自证：已知坏必须红（且点名 decodeMultiFrameZstd），已知好与"长得像坏"必须绿。
 * 抓不到 ⇒ false（调用方必须按失败处理）。
 */
export function selfTest() {
  const bad = analyzeSource(FIXTURE_BAD, "<fixture-bad>").findings;
  const good = analyzeSource(FIXTURE_GOOD, "<fixture-good>").findings;
  const lookalike = analyzeSource(FIXTURE_LOOKALIKE, "<fixture-lookalike>").findings;
  const badHit = bad.filter((f) => f.name === "decodeMultiFrameZstd" && f.kind === "free-identifier").length > 0;
  const ok = badHit && good.length === 0 && lookalike.length === 0;
  return {
    ok,
    badHit,
    badFindings: bad,
    goodFindings: good,
    lookalikeFindings: lookalike,
    message: ok
      ? "自证通过：已知坏被抓到（decodeMultiFrameZstd / free-identifier），已知好与「长得像坏」都是 0"
      : `自证失败：known-bad 命中=${badHit} / known-good 发现=${good.length} / lookalike 发现=${lookalike.length} —— 扫描器不可信，不许当绿`,
  };
}

// ───────────────────────────── CLI ─────────────────────────────

export function main(argv = process.argv.slice(2)) {
  const flag = (name) => argv.includes(`--${name}`);
  const value = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };

  if (flag("self-test")) {
    const st = selfTest();
    console.log("== undefined-ref 自证 ==");
    console.log(`  known-bad    命中 ${st.badFindings.length} 个：${st.badFindings.map((f) => `${f.name}@${f.line}`).join(", ") || "无"}`);
    console.log(`  known-good   命中 ${st.goodFindings.length} 个：${st.goodFindings.map((f) => `${f.name}@${f.line}`).join(", ") || "无（绿）"}`);
    console.log(`  lookalike    命中 ${st.lookalikeFindings.length} 个：${st.lookalikeFindings.map((f) => `${f.name}@${f.line}`).join(", ") || "无（绿）"}`);
    console.log(`${st.ok ? "✓" : "✗"} ${st.message}`);
    return st.ok ? 0 : 2;
  }

  const root = nodePath.resolve(value("root", ROOT));
  const res = audit(root);

  if (flag("json")) {
    console.log(JSON.stringify(res, null, 2));
    return res.findings.length === 0 ? 0 : 1;
  }

  console.log(`== 未定义引用审计 · ${res.scanned} 个文件（scripts/*.mjs + src/**\/*.mjs）==`);
  for (const e of res.errors) console.log(`  ! 读取/解析失败 ${e.file}: ${e.error}`);
  if (res.findings.length === 0) {
    console.log("  0 处：每个被引用的名字都在本文件 import 或声明过。");
    return 0;
  }
  const dirty = res.files.filter((f) => f.findings.length > 0);
  for (const f of dirty) {
    console.log(`\n✗ ${f.file}`);
    for (const x of f.findings) console.log(`   ${x.kind}  ${x.name}  (${x.line}:${x.col})`);
  }
  const k1 = res.findings.filter((f) => f.kind === "free-identifier").length;
  const k2 = res.findings.filter((f) => f.kind === "export-unbound").length;
  console.log(`\n== ${res.findings.length} 处未定义引用，分布在 ${dirty.length} 个文件 ==`);
  console.log(`   其中 free-identifier ${k1} 处（运行必 ReferenceError）· export-unbound ${k2} 处（链接期 SyntaxError）`);
  return 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = main();
