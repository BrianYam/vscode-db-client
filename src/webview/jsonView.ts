/**
 * Pure helpers behind the query panel's JSON viewer (DISCOVERY_JSON_VIEWER.md).
 *
 * Why a source *string* rather than exported functions: this code has to run
 * inside the webview, which receives the panel as one self-contained HTML string
 * under a strict CSP — it cannot import a module. Injecting the functions via
 * `Function.prototype.toString()` was the obvious alternative and is a trap: the
 * shipped build runs esbuild with `minify: true` (`vscode:prepublish`), so any
 * reference to a module-scope name would survive typecheck and tests and then
 * throw a ReferenceError only in the packaged extension. A string literal is
 * passed through the minifier untouched, and the test evaluates this exact text,
 * so what is tested is what ships.
 *
 * Everything here must therefore stay self-contained: no imports, no module
 * constants, no references outside each function.
 */
// This string is JavaScript source, not prose. It happens to contain no escape
// sequence today, but the moment someone adds one to a regex here (\d, \., \\) a plain
// template literal would silently eat the backslash and ship a subtly wrong helper.
// biome-ignore lint/complexity/noUselessStringRaw: source text — keep backslashes literal
export const JSON_VIEW_HELPERS = String.raw`
    // Is this cell a JSON document, and how big? Detection is value-shaped, not
    // type-driven: columnsMeta only exists for tree-driven table previews, so on a
    // hand-typed query the declared 'jsonb' type is simply not known here.
    // pg and mysql2 hand us parsed objects; SQLite and Redis hand us strings.
    function jsonShape(v){
      if (v === null || v === undefined) return null;
      if (typeof v === 'object') {
        // Dates and byte arrays are objects too, and rendering a timestamp as an
        // empty JSON document ("{}") would be worse than the wall of text this
        // feature exists to fix.
        if (v instanceof Date) return null;
        if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(v)) return null;
        var arr = Array.isArray(v);
        return { kind: arr ? 'array' : 'object', count: arr ? v.length : Object.keys(v).length, value: v };
      }
      if (typeof v === 'string') {
        var t = v.trim();
        if (!t || (t.charAt(0) !== '{' && t.charAt(0) !== '[')) return null;
        try {
          var p = JSON.parse(t);
          if (p === null || typeof p !== 'object') return null;
          var a = Array.isArray(p);
          return { kind: a ? 'array' : 'object', count: a ? p.length : Object.keys(p).length, value: p };
        } catch (_) { return null; }
      }
      return null;
    }

    // What the grid cell shows instead of a 5 KB minified line.
    function jsonSummary(shape){
      if (!shape) return '';
      var n = shape.count;
      if (shape.kind === 'array') return n ? '[…] ' + n + ' item' + (n === 1 ? '' : 's') : '[]';
      return n ? '{…} ' + n + ' key' + (n === 1 ? '' : 's') : '{}';
    }

    // esc() covers text nodes (& and < only). Attributes additionally need the
    // quote characters, and JSON keys/values are user data — see Discovery §3.6.
    function escAttr(s){
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;')
                      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }

    // One segment of a copyable path, e.g. .sku or ["odd key"] or [3].
    function jsonPathSeg(key, isIndex){
      if (isIndex) return '[' + key + ']';
      return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(String(key))
        ? '.' + key
        : '[' + JSON.stringify(String(key)) + ']';
    }

    // A one-line preview of a collapsed child, so a folded tree still says
    // something useful about what is inside it.
    function jsonPeek(v){
      if (v === null) return 'null';
      if (typeof v === 'string') return JSON.stringify(v.length > 60 ? v.slice(0, 60) + '…' : v);
      if (typeof v !== 'object') return String(v);
      var s = jsonShape(v);
      return s ? jsonSummary(s) : String(v);
    }
`;
