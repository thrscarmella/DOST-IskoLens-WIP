/* ==========================================================================
   Spreadsheet import modal (Scholar Records + Encode pages).
   Step 1: choose a .xlsx/.csv file. Step 2: the server validates every row
   and reports errors and duplicates. Step 3: the officer saves the valid rows
   (all in one transaction) or cancels. Nothing is saved before step 3.
   ========================================================================== */
const IskoImport = (function () {
  let batch = null;
  let file = null;
  let onDone = null;
  let kind = 'scholars';

  /* The three kinds of import share this dialog; only the endpoints, the
     template and the preview columns differ. */
  const KINDS = {
    scholars: {
      title: 'Import Scholar Records', noun: 'scholar record',
      intro: 'Adds new scholars. Every row is checked for format errors and missing fields. Each saved scholar gets a Scholar ID. You review the result before anything is saved.',
      preview: '/api/scholars/import/preview', commit: id => `/api/scholars/import/${id}/commit`, cancel: id => `/api/scholars/import/${id}/cancel`,
      template: '/api/scholars/import/template',
      cols: ['Row', 'Municipality', 'Program', 'Cycle'],
      row: p => [p.row, p.municipality, p.program, p.cycle]
    },
    academic: {
      title: 'Import GWA Records', noun: 'GWA record',
      intro: 'Adds one GWA per row for existing scholars, matched by Scholar ID. The academic standing is computed for each row. Terms a scholar already has are reported, not overwritten.',
      preview: '/api/records-import/academic/preview', commit: id => `/api/records-import/${id}/commit`, cancel: id => `/api/records-import/${id}/cancel`,
      template: '/api/records-import/academic/template',
      cols: ['Row', 'Scholar ID', 'Term', 'GWA', 'Standing'],
      row: p => [p.row, p.code, p.term, p.gwa, p.standing]
    },
    stipends: {
      title: 'Import Stipend Records', noun: 'stipend record',
      intro: 'Adds one disbursement per row for existing scholars, matched by Scholar ID. Periods a scholar already has are reported, not overwritten.',
      preview: '/api/records-import/stipends/preview', commit: id => `/api/records-import/${id}/commit`, cancel: id => `/api/records-import/${id}/cancel`,
      template: '/api/records-import/stipends/template',
      cols: ['Row', 'Scholar ID', 'Period', 'Amount', 'Status'],
      row: p => [p.row, p.code, p.period, IskoFmt.peso(p.amount), p.status]
    }
  };
  const K = () => KINDS[kind];

  function modal() { return document.getElementById('import-csv-modal'); }

  function renderUpload() {
    batch = null; file = null;
    modal().innerHTML = `
      <div class="modal-box" style="max-width:640px;">
        <div class="modal-header"><span>${esc(K().title)}</span><button class="modal-close" onclick="IskoImport.close()" aria-label="Close">&times;</button></div>
        <div class="modal-body">
          <p class="text-sm text-muted" style="margin-bottom:14px;">Upload an Excel (.xlsx) file or a CSV exported from Google Sheets. ${esc(K().intro)}</p>
          <label class="drop-zone" id="imp-drop" style="display:block; border:2px dashed var(--gray-300); border-radius:10px; padding:28px; text-align:center; cursor:pointer;">
            <i class="fa-solid fa-file-arrow-up" style="font-size:26px; color:var(--blue-600);"></i>
            <div style="margin-top:10px; font-weight:600;" id="imp-file-label">Drag and drop your file here, or <span style="color:var(--blue-600);">browse</span></div>
            <div class="text-sm text-muted" style="margin-top:4px;">.xlsx or .csv, up to 10 MB</div>
            <input type="file" id="imp-input" accept=".xlsx,.csv" class="visually-hidden" aria-label="Choose a .xlsx or .csv file">
          </label>
          <div class="text-sm" style="margin-top:12px;">Need the format? Download the template:
            <a class="link-action" href="${K().template}.xlsx">Excel</a> ·
            <a class="link-action" href="${K().template}.csv">CSV</a></div>
        </div>
        <div class="modal-footer"><button class="btn btn-outline" onclick="IskoImport.close()">Cancel</button>
          <button class="btn btn-primary" id="imp-validate" disabled onclick="IskoImport.validate()"><i class="fa-solid fa-magnifying-glass"></i> Upload & Validate</button></div>
      </div>`;
    const input = document.getElementById('imp-input');
    const drop = document.getElementById('imp-drop');
    input.addEventListener('change', () => choose(input.files[0]));
    ['dragenter', 'dragover'].forEach(e => drop.addEventListener(e, ev => { ev.preventDefault(); drop.classList.add('dragover'); }));
    ['dragleave', 'drop'].forEach(e => drop.addEventListener(e, ev => { ev.preventDefault(); drop.classList.remove('dragover'); }));
    drop.addEventListener('drop', ev => choose(ev.dataTransfer.files[0]));
  }

  function choose(f) {
    if (!f) return;
    const ok = /\.(xlsx|csv)$/i.test(f.name);
    if (!ok) { showToast('Unsupported file', 'Choose a .xlsx or .csv file.', 'error'); return; }
    if (f.size > 10 * 1024 * 1024) { showToast('File too large', 'The file is over the 10 MB limit.', 'error'); return; }
    file = f;
    document.getElementById('imp-file-label').innerHTML = `<i class="fa-solid fa-file-lines"></i> ${esc(f.name)} <span class="text-sm text-muted">(${(f.size / 1024).toFixed(0)} KB)</span>`;
    document.getElementById('imp-validate').disabled = false;
  }

  async function validate() {
    const btn = document.getElementById('imp-validate');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Validating…';
    const fd = new FormData();
    fd.append('file', file);
    try {
      batch = await IskoAPI.request('POST', K().preview, fd);
      renderResult();
    } catch (err) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-magnifying-glass"></i> Upload & Validate';
      IskoAPI.fail(err, 'File not accepted');
    }
  }

  function renderResult() {
    const b = batch;
    const errorsHtml = b.errors.length ? `
      <div style="font-weight:600; font-size:13px; margin:14px 0 8px;">Rows with problems (these will be skipped)</div>
      <div class="import-errors"><table><thead><tr><th scope="col">Row</th><th scope="col">Column</th><th scope="col">Problem</th><th scope="col">Value</th></tr></thead><tbody>
        ${b.errors.map(e => `<tr><td>${e.row}</td><td>${esc(e.column)}</td><td>${esc(e.message)}</td><td class="text-muted">${esc(e.value)}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="inline-note" style="margin-top:8px;">Fix these rows in your file and import them again later. Row numbers match the spreadsheet (the header is row 1).</p>` : '';
    const previewHtml = b.preview.length ? `
      <div style="font-weight:600; font-size:13px; margin:14px 0 8px;">Ready to save${b.valid_rows > b.preview.length ? ` (first ${b.preview.length} of ${b.valid_rows})` : ''}</div>
      <div class="import-errors"><table><thead><tr>${K().cols.map(c => `<th scope="col">${esc(c)}</th>`).join('')}</tr></thead><tbody>
        ${b.preview.map(p => `<tr>${K().row(p).map(v => `<td>${esc(v)}</td>`).join('')}</tr>`).join('')}
      </tbody></table></div>` : '';
    const ignored = b.ignored_columns && b.ignored_columns.length
      ? `<p class="inline-note" style="margin-top:10px;">Columns not recognized and ignored: ${b.ignored_columns.map(esc).join(', ')}</p>` : '';
    modal().innerHTML = `
      <div class="modal-box" style="max-width:760px;">
        <div class="modal-header"><span>Validation result: ${esc(b.filename)}</span><button class="modal-close" onclick="IskoImport.cancel()" aria-label="Cancel import">&times;</button></div>
        <div class="modal-body">
          <div class="import-summary">
            <div><div class="is-num">${b.total_rows}</div><div class="is-lbl">Rows in file</div></div>
            <div><div class="is-num" style="color:var(--green-text);">${b.valid_rows}</div><div class="is-lbl">Ready to save</div></div>
            <div><div class="is-num" style="color:${b.error_rows ? 'var(--red-600)' : 'var(--gray-400)'};">${b.error_rows}</div><div class="is-lbl">Rows with problems</div></div>
          </div>
          ${previewHtml}${errorsHtml}${ignored}
        </div>
        <div class="modal-footer"><button class="btn btn-outline" onclick="IskoImport.cancel()">Cancel import</button>
          ${b.valid_rows ? `<button class="btn btn-primary" id="imp-commit" onclick="IskoImport.commit()"><i class="fa-solid fa-floppy-disk"></i> Save ${b.valid_rows} ${K().noun}${b.valid_rows > 1 ? 's' : ''}</button>` : ''}</div>
      </div>`;
  }

  async function commit() {
    const btn = document.getElementById('imp-commit');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving…';
    try {
      const res = await IskoAPI.post(K().commit(batch.batch_id));
      batch = null;
      close(true);
      showToast('Import saved', `${res.created} ${K().noun}${res.created > 1 ? 's were' : ' was'} added.${res.skipped ? ` ${res.skipped} row(s) with problems were skipped.` : ''}${res.below_requirement_twice ? ` ${res.below_requirement_twice} scholar(s) are now below the GWA requirement for 2 semesters in a row; officers were notified.` : ''}`);
      if (onDone) onDone(res);
    } catch (err) {
      btn.disabled = false;
      btn.innerHTML = 'Try again';
      IskoAPI.fail(err, 'Nothing was saved');
    }
  }

  async function cancel() {
    if (batch) { IskoAPI.post(K().cancel(batch.batch_id)).catch(() => {}); batch = null; }
    close();
  }

  function close() {
    closeModal('import-csv-modal');
    setTimeout(renderUpload, 200);
  }

  function open(done, which) {
    onDone = done || onDone;
    kind = KINDS[which] ? which : 'scholars';
    renderUpload();
    openModal('import-csv-modal');
  }

  return { open, validate, commit, cancel, close };
})();
