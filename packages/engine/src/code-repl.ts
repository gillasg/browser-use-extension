import { parse, type Node, type Pattern } from "acorn";

/**
 * REPL semantics for a browser_code cell evaluated with indirect eval: top-level bindings
 * persist between cells, top-level await works, and the last expression is the cell's value.
 */
export function toReplScript(code: string): string {
  let program: { body: Node[] };
  try {
    program = parse(code, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    }) as unknown as { body: Node[] };
  } catch {
    // Let evaluation report the syntax error with its native message.
    return `(async () => {${code}\n})()`;
  }
  const names = new Set<string>();
  const functions: string[] = [];
  const edits: [number, number, string][] = [];
  const text = (node: Node) => code.slice(node.start, node.end);
  for (const statement of program.body) rewrite(statement, code, names, functions, edits);
  const last = program.body.at(-1) as (Node & { expression?: Node }) | undefined;
  if (last?.type === "ExpressionStatement" && last.expression)
    edits.push([last.start, last.end, `return (${text(last.expression)});`]);
  let body = code;
  for (const [start, end, replacement] of edits.sort((a, b) => b[0] - a[0]))
    body = body.slice(0, start) + replacement + body.slice(end);
  // A built-in read-only global (history, location, name, status…) can't hold the agent's value:
  // `history = x` would silently keep window.history. Such names stay local to this cell.
  const fixed = [...names].filter(isReadOnlyGlobal);
  const declarations = [...names]
    .filter((name) => !fixed.includes(name))
    .map((name) => `var ${name};`)
    .join("");
  const locals = fixed.length
    ? `let ${fixed.join(", ")};console.log(${JSON.stringify(`Note: ${fixed.join(", ")} ${fixed.length === 1 ? "is a browser global name" : "are browser global names"}, so ${fixed.length === 1 ? "it stays" : "they stay"} in this cell only; pick another name to keep a value for later cells.`)});`
    : "";
  const exports = functions.map((name) => `globalThis.${name} = ${name};`).join("");
  return `${declarations}(async () => {${locals}${exports}${body}\n})()`;
}

/**
 * True for globals an assignment can't simply replace: read-only values, and the browser's own
 * getters and setters (window.history ignores it, window.name turns it into a string, and
 * window.location navigates). Values from earlier cells are plain writable properties.
 */
function isReadOnlyGlobal(name: string): boolean {
  for (let owner: object | null = globalThis; owner; owner = Object.getPrototypeOf(owner)) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, name);
    if (descriptor) return "value" in descriptor ? descriptor.writable === false : true;
  }
  return false;
}

function rewrite(
  statement: Node,
  code: string,
  names: Set<string>,
  functions: string[],
  edits: [number, number, string][],
): void {
  const node = statement as Node & Record<string, unknown>;
  const text = (item: Node) => code.slice(item.start, item.end);
  const id = node.id as { name: string } | null | undefined;
  if (node.type === "FunctionDeclaration" && id) functions.push(id.name);
  if (node.type === "ClassDeclaration" && id) {
    names.add(id.name);
    edits.push([node.start, node.end, `${id.name} = ${text(node)};`]);
  }
  if (node.type !== "VariableDeclaration") return;
  const declarations = node.declarations as (Node & { id: Pattern; init: Node | null })[];
  for (const declaration of declarations) collect(declaration.id, names);
  const assignments = declarations
    .filter((declaration) => declaration.init)
    .map((declaration) => `(${text(declaration.id)} = (${text(declaration.init as Node)}))`);
  edits.push([
    node.start,
    node.end,
    assignments.length ? `void (${assignments.join(", ")});` : ";",
  ]);
}

function collect(pattern: Pattern | null, names: Set<string>): void {
  if (!pattern) return;
  if (pattern.type === "Identifier") names.add(pattern.name);
  else if (pattern.type === "ObjectPattern")
    for (const property of pattern.properties)
      collect(property.type === "RestElement" ? property.argument : property.value, names);
  else if (pattern.type === "ArrayPattern")
    for (const element of pattern.elements) collect(element, names);
  else if (pattern.type === "RestElement") collect(pattern.argument, names);
  else if (pattern.type === "AssignmentPattern") collect(pattern.left, names);
}
