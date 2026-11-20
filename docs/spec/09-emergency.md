# 9. The emergency card

A medical card the owner publishes for whoever finds them, readable by anyone with its link and by nobody else, the site included.

## The card

```json
{ "v": 1, "name": "...", "bloodType": "O-", "allergies": "...", "medication": "...", "conditions": "...",
  "contacts": [{ "name": "...", "phone": "...", "relation": "..." }], "language": "...", "notes": "...", "updatedAt": "..." }
```

The blood type is one of A+, A-, B+, B-, AB+, AB-, O+, O- or empty; at most four contacts; phone numbers keep only digits, spaces, `+`, `(`, `)` and `-`.

## The key in the link

The device makes a fresh 32-byte key K for each card id. The card is an envelope (part 2) under K with the AAD `sigil:emergency:<card id>`. The link is

```
<origin>/e/<card id>#<base64url K>
```

Browsers never send the part after `#` to a server, so the site stores and serves ciphertext it cannot open. The owner keeps K and the card in an envelope under the vault key, AAD `sigil:emergency-owner:<card id>`, to show the code again. Changing the card keeps the id and K; issuing a new code makes a new id and K and deletes the old card, so the old link opens nothing. The `emergencyCard` vector holds a card sealed under a key, to be opened. The `recordAad` vector lists the AAD of this part, of drafts and proofs kept by the owner (`sigil:draft:<id>`, `sigil:disclosure:<id>`) and of each side's copy of an agreement (`sigil:agreement:<id>`).

## Openings

`GET /api/e/<card id>` returns the ciphertext. Each call is recorded for the owner with the time, a device class (phone, tablet, computer or unknown, from the user agent) and the first language the browser asks for; no address, cookie or other identifier is kept. Each opening is also an `emergency` entry of the owner's log (part 4). A page that opened a card may keep its ciphertext on that device to open it again without a connection; it forgets it when the site says the card is gone.
