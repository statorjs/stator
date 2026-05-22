import { html, type HtmlFragment } from '@statorjs/stator/template'

/**
 * Plain HTML form posting to /new. The framework's POST handler
 * (defineApiRoute in routes/new.ts) parses the FormData, dispatches
 * CREATE_POLL to VoterMachine, returns a navigate directive.
 *
 * The `data-stator-enhance` attribute opts the form into client-runtime
 * interception. Without it, the form would still work (browser submits,
 * server returns 303 to `/`), but the user would see a full-page
 * navigation rather than the framework applying the navigate directive
 * client-side.
 *
 * Works two ways:
 *   - No JS or no enhance attribute: the form submits normally, server
 *     returns a 303 to `/`.
 *   - With JS and enhance attribute: the client runtime intercepts,
 *     POSTs as FormData with Accept: application/json, applies the
 *     navigate directive client-side.
 *
 * The "add option" button is the one piece of inline JS that's genuinely
 * client-only — it adds input rows dynamically with no server round trip.
 * The form starts with two rows so the no-JS path still works.
 */
export default function newPollPage(): HtmlFragment {
  return html`<section class="page page--new">
  <header class="page-header">
    <h1>New poll</h1>
    <p class="page-lede">Two to six options. Plain text only.</p>
  </header>

  <form action="/new" method="POST" class="form" data-stator-enhance>
    <label class="field">
      <span class="field-label">Question</span>
      <input type="text" name="question" maxlength="200" required autocomplete="off" placeholder="What should we ask?" />
    </label>

    <fieldset class="options">
      <legend>Options</legend>
      <div class="option-rows">
        <label class="option-row">
          <span class="option-num">1</span>
          <input type="text" name="option" maxlength="100" required autocomplete="off" placeholder="Option text" />
        </label>
        <label class="option-row">
          <span class="option-num">2</span>
          <input type="text" name="option" maxlength="100" required autocomplete="off" placeholder="Option text" />
        </label>
      </div>
      <button type="button" id="add-option" class="btn btn-secondary">+ Add option</button>
    </fieldset>

    <div class="form-actions">
      <a href="/" class="btn btn-text">Cancel</a>
      <button type="submit" class="btn btn-primary">Create poll →</button>
    </div>
  </form>

  <script>
    (function () {
      var rows = document.querySelector('.option-rows')
      var addBtn = document.getElementById('add-option')
      var MAX = 6

      function renumber() {
        var nums = rows.querySelectorAll('.option-num')
        for (var i = 0; i < nums.length; i++) nums[i].textContent = String(i + 1)
        addBtn.disabled = nums.length >= MAX
      }

      addBtn.addEventListener('click', function () {
        var count = rows.querySelectorAll('.option-row').length
        if (count >= MAX) return
        var label = document.createElement('label')
        label.className = 'option-row'
        label.innerHTML =
          '<span class="option-num"></span>' +
          '<input type="text" name="option" maxlength="100" required autocomplete="off" placeholder="Option text" />'
        rows.appendChild(label)
        renumber()
        label.querySelector('input').focus()
      })

      renumber()
    })()
  </script>
</section>`
}
