import { describe, it, expect } from 'vitest';
import {
  IMPORT_FORM_FIELD,
  IMPORT_INTENT,
  MAX_IMPORT_BYTES,
  isImportIntent,
  itemCount,
  problemHeading,
  readImportSubmission,
  readyHeading,
} from '../src/lib/gear/import-form';

/**
 * The import page's submission (PK-65): which step a POST is, and where its bytes came
 * from. The gate between "show me what this would do" and "do it" lives here rather than
 * in `src/pages/gear/import.astro`, because `vitest.config.ts` excludes `src/pages/**`
 * and a gate nothing can execute is not a gate — the same argument `confirmsGearDeletion`
 * records for the delete path.
 */

function form(entries: Record<string, string | File>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.append(key, value);
  return data;
}

function jsonFile(body: string, name = 'gear.json'): File {
  return new File([body], name, { type: 'application/json' });
}

describe('the intent', () => {
  it('accepts exactly the two steps', () => {
    expect(isImportIntent(IMPORT_INTENT.preview)).toBe(true);
    expect(isImportIntent(IMPORT_INTENT.confirm)).toBe(true);
  });

  it('refuses anything that merely looks plausible', () => {
    for (const value of ['preview', 'confirm', 'import', '', ' import-confirm', 1, null, {}]) {
      expect(isImportIntent(value)).toBe(false);
    }
  });

  it('refuses a submission carrying no recognised intent', async () => {
    const result = await readImportSubmission(form({ [IMPORT_FORM_FIELD.text]: '{}' }));
    expect(result.ok).toBe(false);
  });
});

describe('where the bytes come from', () => {
  it('reads an uploaded file', async () => {
    const result = await readImportSubmission(
      form({
        [IMPORT_FORM_FIELD.intent]: IMPORT_INTENT.preview,
        [IMPORT_FORM_FIELD.file]: jsonFile('{"name":"A tent"}'),
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe('{"name":"A tent"}');
      expect(result.intent).toBe(IMPORT_INTENT.preview);
    }
  });

  it('reads the paste box when no file was chosen', async () => {
    const result = await readImportSubmission(
      form({
        [IMPORT_FORM_FIELD.intent]: IMPORT_INTENT.confirm,
        [IMPORT_FORM_FIELD.text]: '{"name":"A tent"}',
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.intent).toBe(IMPORT_INTENT.confirm);
  });

  it('ignores an empty file input, which is what a browser posts when nothing was chosen', async () => {
    const result = await readImportSubmission(
      form({
        [IMPORT_FORM_FIELD.intent]: IMPORT_INTENT.preview,
        [IMPORT_FORM_FIELD.file]: new File([], ''),
        [IMPORT_FORM_FIELD.text]: '{"name":"pasted"}',
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toBe('{"name":"pasted"}');
  });

  it('prefers the file when both carry something', async () => {
    const result = await readImportSubmission(
      form({
        [IMPORT_FORM_FIELD.intent]: IMPORT_INTENT.preview,
        [IMPORT_FORM_FIELD.file]: jsonFile('{"name":"from the file"}'),
        [IMPORT_FORM_FIELD.text]: '{"name":"from the box"}',
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toContain('from the file');
  });

  it('refuses a submission with neither', async () => {
    const result = await readImportSubmission(
      form({ [IMPORT_FORM_FIELD.intent]: IMPORT_INTENT.preview }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Choose a file');
  });

  it('treats a whitespace-only paste as nothing', async () => {
    const result = await readImportSubmission(
      form({
        [IMPORT_FORM_FIELD.intent]: IMPORT_INTENT.preview,
        [IMPORT_FORM_FIELD.text]: '   \n',
      }),
    );
    expect(result.ok).toBe(false);
  });
});

describe('the size cap', () => {
  it('refuses a file over the cap', async () => {
    const result = await readImportSubmission(
      form({
        [IMPORT_FORM_FIELD.intent]: IMPORT_INTENT.preview,
        [IMPORT_FORM_FIELD.file]: jsonFile('x'.repeat(MAX_IMPORT_BYTES + 1)),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('1 MB');
  });

  it('accepts a file exactly at the cap', async () => {
    const result = await readImportSubmission(
      form({
        [IMPORT_FORM_FIELD.intent]: IMPORT_INTENT.preview,
        [IMPORT_FORM_FIELD.file]: jsonFile('x'.repeat(MAX_IMPORT_BYTES)),
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('measures the paste box in bytes, not characters', async () => {
    // '€' is three bytes in UTF-8. Measuring `.length` would apply a limit three times
    // larger to any file with non-ASCII gear names in it, which is most of them.
    const justOver = '€'.repeat(Math.floor(MAX_IMPORT_BYTES / 3) + 1);
    expect(justOver.length).toBeLessThan(MAX_IMPORT_BYTES);
    const result = await readImportSubmission(
      form({
        [IMPORT_FORM_FIELD.intent]: IMPORT_INTENT.preview,
        [IMPORT_FORM_FIELD.text]: justOver,
      }),
    );
    expect(result.ok).toBe(false);
  });
});

describe('counting things out loud', () => {
  it('agrees the noun with the number', () => {
    expect(itemCount(1)).toBe('1 item');
    expect(itemCount(0)).toBe('0 items');
    expect(itemCount(6)).toBe('6 items');
  });

  it('agrees the verb with the number of problems, not with the total', () => {
    // The bug this exists to prevent, caught in a browser: "7 of 8 items needs fixing".
    expect(problemHeading(7, 8)).toBe('7 of 8 items need fixing');
    expect(problemHeading(1, 8)).toBe('1 of 8 items needs fixing');
    expect(problemHeading(1, 1)).toBe('1 of 1 item needs fixing');
  });

  it('reads correctly for a single clean item', () => {
    expect(readyHeading(1)).toBe('Ready to import 1 item');
    expect(readyHeading(6)).toBe('Ready to import 6 items');
  });
});

describe('totality', () => {
  it('does not throw on an empty form', async () => {
    await expect(readImportSubmission(new FormData())).resolves.toMatchObject({ ok: false });
  });

  it('does not throw when a File arrives under the intent field', async () => {
    const data = new FormData();
    data.append(IMPORT_FORM_FIELD.intent, jsonFile('{}'));
    data.append(IMPORT_FORM_FIELD.text, '{"name":"x"}');
    await expect(readImportSubmission(data)).resolves.toMatchObject({ ok: false });
  });

  it('does not throw when a File arrives under the text field', async () => {
    const data = new FormData();
    data.append(IMPORT_FORM_FIELD.intent, IMPORT_INTENT.preview);
    data.append(IMPORT_FORM_FIELD.text, jsonFile('{}'));
    await expect(readImportSubmission(data)).resolves.toMatchObject({ ok: false });
  });
});
