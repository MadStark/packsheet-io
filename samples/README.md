# Packsheet JSON samples

Example files for the gear-items half of Packsheet JSON (PK-65), for trying the importer
at `/gear/import` and for reading when you are writing a file by hand.

`tests/gear-json-samples.test.ts` runs every file here through the real parser, so an
example that stops being valid fails the build rather than quietly becoming wrong
documentation. If you change the format, change these too — the test will tell you.

| File                         | Shape                       | Imports?                       |
| ---------------------------- | --------------------------- | ------------------------------ |
| `packsheet-gear-sample.json` | The versioned envelope      | Yes — 6 items                  |
| `gear-items-array.json`      | A bare array of items       | Yes — 3 items                  |
| `gear-item-single.json`      | A single bare item          | Yes — 1 item                   |
| `gear-items.jsonl`           | JSONL, one item per line    | Yes — 4 items                  |
| `gear-items-broken.json`     | A bare array, 7 rows broken | No — refused whole, on purpose |

Export always writes the first shape, even for one item. Import accepts all four.

## The item

```json
{
  "name": "Nemo Hornet OSMO 2P",
  "brand": "Nemo",
  "category": "Shelter",
  "description": "Two-person semi-freestanding tent",
  "quantity": 1,
  "weight_grams": 963,
  "price": 429.99,
  "currency": "GBP",
  "acquired_on": "2024-05-01",
  "status": "owned",
  "url": "https://www.nemoequipment.com/products/hornet-osmo",
  "notes": "Fly pitches first in the rain"
}
```

`name` is the only field you have to give. Everything else may be omitted or `null`;
`quantity` then defaults to 1, `weight_grams` to 0 and `status` to `owned`.

Worth knowing before you write one by hand:

- **Weight is grams, in one field, with no unit.** There is no `weight` or `weight_unit`
  in this format — a file carrying either is refused by name rather than silently read as
  weighing nothing. Up to three decimal places.
- **`price` and `currency` are both present or both absent.** The currency is any
  three-letter uppercase code; a closet may mix them.
- **`status` is one of `owned`, `wishlist`, `retired`**, lower case.
- **`acquired_on` is `YYYY-MM-DD` or `null`.** Empty means "I don't know", not today, and
  a date in the future is refused.
- **No database identifiers.** No `id`, no `user_id`. Import always creates new items and
  never matches or merges with what is already in your closet.
- **Unknown fields are refused**, rather than ignored — a misspelling that silently
  dropped a value would be worse than a file that will not import.

An import is all-or-nothing: if any row has a problem, the preview names every one of them
and nothing is written.
