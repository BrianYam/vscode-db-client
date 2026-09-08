/**
 * Pure helpers behind the query panel's column picker
 * (DISCOVERY_COLUMN_PICKER.md).
 *
 * Shipped as a source string for the same reason as `jsonView.ts`: this runs
 * inside the webview, which cannot import a module, and the packaged build
 * minifies (`vscode:prepublish` → `--production`) — so injecting functions via
 * `Function.prototype.toString()` would pass typecheck and tests and then throw
 * only in the shipped extension. A string literal survives the minifier, and the
 * test evaluates this exact text.
 *
 * Self-contained by necessity: no imports, no module constants.
 */
export const COLUMN_VIEW_HELPERS = String.raw`
    // The columns to render, in result order. Hiding never reorders — this is a
    // visibility control, not a reordering one — and hidden names that are not in
    // the result (a stale set from a previous query) are simply ignored.
    function visibleColumns(all, hidden){
      if (!all) return [];
      if (!hidden || !hidden.size) return all.slice();
      return all.filter(function (c) { return !hidden.has(c); });
    }

    // Narrow rows to the given columns, preserving column order. Used for Copy
    // and Export so both carry what the user was actually looking at.
    function projectRows(rows, columns){
      if (!rows) return [];
      return rows.map(function (row) {
        var out = {};
        for (var i = 0; i < columns.length; i++) {
          var c = columns[i];
          // Keep the key even when the value is undefined, so every projected row
          // has the same shape — a ragged CSV or JSON array is worse than a null.
          out[c] = row[c];
        }
        return out;
      });
    }

    // Every column except the first, as a hidden-set. The bulk "hide all" has to
    // land somewhere legal: a zero-column grid is a blank rectangle, and the
    // picker already refuses to uncheck the last remaining box, so the bulk
    // action honours that same floor rather than inventing a second rule. The
    // FIRST column survives because it is usually the key you identify a row by.
    function hideAllButFirst(all){
      var out = new Set();
      if (!all || all.length < 2) return out;
      for (var i = 1; i < all.length; i++) out.add(all[i]);
      return out;
    }

    // Identity of a result's column set. Visibility resets when this changes, so
    // a different query starts clean while re-running the same one keeps the
    // user's choice. Newline-joined: a column name cannot contain one.
    function columnsKey(all){
      return (all || []).join('\n');
    }
`;
