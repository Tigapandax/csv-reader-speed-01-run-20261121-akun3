// A fast drop-in for csv-reader 1.0.0 (make.fun's reference CSV reader).
//
// run(input) answers exactly as readCsv does for {text, header}, returning
// {columns, rows, errors}. The policy, restated from the kit's competition
// description:
//
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF; a line left with no characters is no record;
//   - outside a quoted field, a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not
//     doubled: "" inside it is one quote, and each CRLF or lone CR inside it
//     is read as LF; whatever follows the closing quote, up to the next comma
//     or line break, is appended as it stands (quote_junk, when the field
//     ends); a quote that never closes is a literal character, and the text
//     after it is read again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay
//     strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds
//     the records after it (every record when header is false), each padded
//     with "" (short_row, with fields: its field count) or cut (long_row, with
//     extra: the cut fields) to the first record's width;
//   - each error is {code, line, row}, in the order met; line is the 1-based
//     line its record starts on, row its record's index in rows (null for the
//     header).
//
// How it is fast: the reference walks one character at a time. This reader
// never steps character by character over ordinary text. A record whose line
// holds no quote and no stray CR is taken whole with one split(','). Every
// other field is bounded by indexOf jumps to the next delimiter or quote, so
// long clean stretches are skipped in one slice. Only the rare shapes — a
// stray CR inside a field, junk after a closing quote, a quote that never
// closes — fall back to segment-by-segment handling.

/** How a field ended: 0 at a comma, 1 at a line break, 2 at the end of the text. */
const AT_COMMA = 0;
const AT_BREAK = 1;
const AT_END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on, and the index in rows it
  // takes (null while the header is being read). Field readers below report
  // their errors against these two.
  let recordLine = 1;
  let recordRow = null;

  // Reads unquoted characters onto `value` up to the next comma, line break,
  // or the end of the text. A CR not followed by LF is dropped, one
  // stray_cr error each. Returns the field, how it ended, and `kept`: how
  // many characters were added (a caller uses it to tell whether junk
  // followed a closing quote).
  function readPlain(value) {
    let kept = 0;
    const commaAt = text.indexOf(',', pos);
    const nlAt = text.indexOf('\n', pos);
    let end;
    let ended;
    if (commaAt !== -1 && (nlAt === -1 || commaAt < nlAt)) {
      end = commaAt;
      ended = AT_COMMA;
    } else if (nlAt !== -1) {
      end = nlAt;
      ended = AT_BREAK;
    } else {
      end = n;
      ended = AT_END;
    }
    // A CRLF ends the record without the CR joining the field.
    let stop = end;
    if (ended === AT_BREAK && end > pos && text.charCodeAt(end - 1) === 13) stop = end - 1;
    if (stop > pos) {
      const piece = text.slice(pos, stop);
      const crAt = piece.indexOf('\r');
      if (crAt === -1) {
        value += piece;
        kept += piece.length;
      } else {
        // Rare: stray CRs inside the piece. Drop each one, one error each,
        // and keep everything around them.
        let from = 0;
        for (let i = crAt; i !== -1; i = piece.indexOf('\r', i + 1)) {
          if (i > from) {
            value += piece.slice(from, i);
            kept += i - from;
          }
          errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
          from = i + 1;
        }
        if (from < piece.length) {
          value += piece.slice(from);
          kept += piece.length - from;
        }
      }
    }
    if (ended === AT_COMMA) {
      pos = end + 1;
    } else if (ended === AT_BREAK) {
      pos = end + 1;
      line += 1;
    } else {
      pos = n;
    }
    return { value, ended, kept };
  }

  // Reads a quoted field whose opening quote is at pos. Returns the field
  // and how it ended, in the same shape as readPlain.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let look = pos + 1;
    let closedAt = -1;
    let doubled = false;
    for (;;) {
      const q = text.indexOf('"', look);
      if (q === -1) break;
      if (q + 1 < n && text.charCodeAt(q + 1) === 34) {
        doubled = true;
        look = q + 2;
        continue;
      }
      closedAt = q;
      break;
    }
    if (closedAt === -1) {
      // The quote never closes: it is a literal character, and the text
      // after it is read again as unquoted.
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      return readPlain('"');
    }
    const span = text.slice(open + 1, closedAt);
    let value = span;
    if (doubled) value = value.replaceAll('""', '"');
    if (value.indexOf('\r') !== -1) value = value.replace(/\r\n?/g, '\n');
    // Every line break inside the quoted span moves the line count by one;
    // after the CR normalisation above, each break is exactly one LF.
    let breaks = 0;
    let at = -1;
    while ((at = value.indexOf('\n', at + 1)) !== -1) breaks += 1;
    line += breaks;
    pos = closedAt + 1;
    if (pos >= n) return { value, ended: AT_END, kept: 0 };
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      return { value, ended: AT_COMMA, kept: 0 };
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      return { value, ended: AT_BREAK, kept: 0 };
    }
    if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return { value, ended: AT_BREAK, kept: 0 };
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break.
    const junk = readPlain(value);
    if (junk.kept > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    return junk;
  }

  // Finishes a record: sets the width, the header, or a padded/cut row.
  function finishRecord(fields) {
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Whole-line shortcut: this line holds no quote and no stray CR, so the
    // record is exactly this one line, taken with a single split.
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? n : nl;
    const bodyEnd = nl !== -1 && lineEnd > pos && text.charCodeAt(lineEnd - 1) === 13 ? lineEnd - 1 : lineEnd;
    const body = text.slice(pos, bodyEnd);
    if (body.indexOf('"') === -1 && body.indexOf('\r') === -1) {
      const fields = body.split(',');
      pos = nl === -1 ? n : nl + 1;
      if (nl !== -1) line += 1;
      finishRecord(fields);
      continue;
    }

    // Otherwise read the record field by field; a quoted field may run past
    // this line.
    const fields = [];
    let ended = AT_COMMA;
    let lastQuoted = false;
    do {
      lastQuoted = text.charCodeAt(pos) === 34;
      const f = lastQuoted ? readQuoted() : readPlain('');
      fields.push(f.value);
      ended = f.ended;
    } while (ended === AT_COMMA);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;
    finishRecord(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
