# URGE: USN ReadMe File Generator
[Features](#key-features) · [Export](#exporting-your-documentation) · [Install](#installation) · [Configuration](#configuration) · [License](#license)
> Research data deserves documentation as good as the data itself.

**URGE** helps researchers create detailed, standardised README files for their
datasets in line with the **FAIR principles**: Findable, Accessible,
Interoperable, and Reusable. Rather than starting from an empty page, you import
what already exists, whether that is a data management plan, an earlier README,
or a repository record (Dataverse, Figshare, or Zenodo), and URGE fills in what
it can and guides you through the rest.

It is built for the people who carry dataset documentation in practice:
researchers preparing a deposit, data managers reviewing submissions, and
institutions maintaining consistent documentation standards.

> **Privacy:** URGE does not keep accounts, saved drafts, or form content.
> The only data written to disk is anonymous usage statistics: how many times
> the main page is opened, and how many times certain buttons are used (for
> example Generate README). Those counts have no names, no user IDs, no IP
> addresses, and no form fields — they cannot identify a person. Form text
> stays in the browser session and is discarded when the session ends. API
> tokens are used only for the request you make and are never stored.
> Optional actions (repository import or deposit, ORCID lookup, grammar check)
> contact the service you chose, and only when you trigger them. The in-app
> Privacy page (`/privacy`) has the full policy.

## Key features

- **Multiple import options.** Start from a DMP (SIKT DMP, DSW ELIXIR-NO), an
  existing README or JSON export, or a Dataverse, Figshare, or Zenodo record.
- **Smart metadata handling.** Metadata is fetched from the selected repository
  and used to pre-populate the form, so you do not retype what the repository
  already knows.
- **Optional grammar check.** Check the dataset description against the
  LanguageTool public API before you export. This is not required to download
  or send a README.
- **Flexible export.** Produce a standard README or an anonymous version for
  blind review and restricted sharing, or send the README to a Dataverse or
  Figshare draft.
- **JSON output.** Export the same metadata in a machine-readable form.
- **Interactive interface.** A guided form with tooltips and inline explanations
  at every step.
- **QR codes.** Generate a scannable code for the dataset DOI, useful on posters
  and slides. Codes are rendered in your browser and never sent to the server.

## Why it matters

| Benefit | What it means in practice |
|---|---|
| Consistency | Every dataset is documented against the same structure |
| Reuse | Others can understand and work with your data without asking you |
| Compliance | Aligns with institutional and funder data management requirements |
| Discoverability | Better described datasets are easier to find and to cite |

## Import sources

| Source | Role |
|---|---|
| SIKT DMP | Import project and dataset context from an existing plan |
| DSW ELIXIR-NO | Import structured DMP content |
| Existing README | Continue from documentation you have already written |
| JSON export | Reload the structured field values from a previous URGE export |
| Dataverse | Fetch and pre-populate dataset metadata directly from the record |
| Figshare | Fetch drafts and article metadata from your account |
| Zenodo | Fetch drafts and deposition metadata from your account |

## Exporting your documentation

When the form is complete, URGE generates the output and either hands it to you
as a download or sends it into a repository draft.

| Export | Contains | Typical use |
|---|---|---|
| **Generate ReadMe File** (`.txt`) | Full documentation, including contributor names, contact details, and affiliations | The version you deposit alongside the dataset |
| **Anonymous ReadMe File** (`.txt`) | The same documentation with identifying details removed | Blind peer review, restricted sharing, pre-publication circulation |
| **JSON File** (`.json`) | The structured field values behind the form | Machine-readable reuse, ingest into other systems, archiving your own inputs |
| **Send to Dataverse** | The README as `00_Readme.txt` | Uploading straight into the dataset draft |
| **Send to Figshare** | The README as `00_Readme.txt` | Uploading straight into the selected Figshare draft article |

Zenodo is an import source only; URGE does not upload files to Zenodo.

### Send to Dataverse or Figshare

Instead of downloading the README and uploading it yourself, you can send it
from the form. The file is added to a **draft**, so nothing becomes public until
you review and publish it in the repository as usual.

- **Send to Dataverse** — after you connect with an API token and DOI, the
  browser uploads the file to the dataset draft. You must be connected first
  (the button shows Connected / Not connected).
- **Send to Figshare** — after you connect and select a draft, URGE uploads the
  file on the server (the Figshare API does not allow the browser to talk to it
  directly). The token is used only for that request and is never stored.

1. Complete the form, or import an existing DMP, README, JSON export, or
   repository record.
2. Optionally run the grammar check on the dataset description and resolve any
   flagged issues. This step is not required.
3. Choose **Send to Dataverse** or **Send to Figshare**.
4. Open the draft in the repository, check the uploaded file, and publish when
   you are satisfied.

Direct send and the downloadable exports are not mutually exclusive. Many users
send the standard README to the dataset and keep the JSON export as a local
record of their inputs.

### How to export as a file

1. Complete the form.
2. Choose your export: standard README, anonymous README, or JSON metadata.
   You can download more than one; they are generated from the same content.
3. The file is downloaded to your device.

### Round-tripping your work

URGE has no accounts and does not save drafts. Form content is not written to
the statistics database. To continue later, keep one of your exports and
re-import it:

- Re-import the **README** to resume editing the documentation itself.
- Keep the **JSON** as a durable record of the structured field values.

Sending the file to Dataverse or Figshare also preserves your work, since it
then lives in the repository draft.

## Application surface

- **Main UI** (`/`) — Guided README workflow with client-side checks and
  server-assisted metadata fetching. Opening this page increments the anonymous
  page-view counter.
- **Updates & privacy** — Pages at `/updates` and `/privacy`.
- **Dataverse** — Dataset preview and metadata (`POST /fetch_dataset_preview`,
  `POST /fetch_dataverse_metadata`), native API access (`POST /fetch_dataset_api`),
  user drafts (`POST /fetch_user_drafts`), citation helper (`POST /get_citation`),
  session metadata reset (`POST /api/clear_session_metadata`).
- **ORCID** — `GET /api/orcid_search`.
- **Figshare** — Draft and article fetch (`POST /fetch_figshare_drafts`,
  `POST /fetch_figshare_article`) and README upload (`POST /send_figshare_readme`).
- **Zenodo** — Draft and deposition fetch (`POST /fetch_zenodo_drafts`,
  `POST /fetch_zenodo_deposition`).
- **QR codes** — Generated in the browser (no server storage).
- **Usage statistics** — `POST /api/record_button_click` records a daily count
  per button (no identifiers, no form content). Together with the page-view
  counter, this is the only data URGE stores.

## Requirements

- **Python 3** (version aligned with your environment).
- Dependencies in [`requirements.txt`](requirements.txt) — install with `pip install -r requirements.txt`.

Core libraries used by the app include Flask, `requests`, BeautifulSoup, and
Gunicorn. QR codes are rendered client-side.

## Installation

```bash
cd /path/to/urge
python -m venv .venv
# Windows:
.venv\Scripts\activate
# Linux / macOS:
# source .venv/bin/activate
pip install -r requirements.txt
```

Run from the **project root** so imports and `instance/` paths resolve correctly.

## Configuration

### Environment variables

| Variable | Purpose |
|----------|---------|
| `FLASK_SECRET_KEY` or `SECRET_KEY` | Session signing key. If unset, the app may create `instance/secret.key`. |
| `URGE_ENV` | Set to `production` for production-like behavior (e.g. secure session cookies, HSTS when the request is HTTPS). |
| `URGE_DATAVERSE_ALLOWED_HOSTS` | Comma-separated extra Dataverse hostnames. The built-in trusted list is **dataverse.no** and **demo.dataverse.no** (`_DEFAULT_DATAVERSE_ALLOWED_HOSTS` in `app.py`). Other instances work only if you add their hosts here (subdomains of a listed host are included). The user's API token is forwarded to whichever instance is selected; add only hosts you trust. If this variable is unset, empty, or malformed, URGE uses that built-in list only (it never opens the list to all hosts). |

### `instance/` directory

The Flask instance folder holds runtime data (default: `instance/` next to the app):

| Path | Description |
|------|-------------|
| `secret.key` | Auto-generated Flask secret if no env key is set (optional). |
| `viewcount.db` | SQLite file for the page-view counter and daily button statistics. Counts only; no identifiers. |

`.gitignore` excludes `instance/secret.key` and `instance/*.db`. Do not commit
secrets or databases.

## Running the application

**Development** (debug is enabled when `URGE_ENV` is not `production`, and only
when you start the app with `python app.py`):

```bash
python app.py
```

**Production** (Gunicorn on Linux or macOS — adjust host, port, and workers).
Gunicorn does not run natively on Windows.

```bash
export URGE_ENV=production
export FLASK_SECRET_KEY=your-secret-here
gunicorn -w 4 -b 0.0.0.0:8000 app:app
```

Use HTTPS termination (reverse proxy) in production; `Strict-Transport-Security`
is applied when the request is secure.

## Project layout

```
app.py              # Flask application and routes
view_counter.py     # Anonymous page-view counter
button_stats.py     # Aggregated button-click counts
templates/          # HTML templates
static/             # CSS, JS, assets
instance/           # Runtime files (secret key and SQLite DBs are gitignored)
tests/              # Automated tests
```

## License

This project is licensed under the [GNU Affero General Public License v3.0](https://www.gnu.org/licenses/agpl-3.0.html) (AGPL-3.0). See [`LICENSE`](LICENSE) for the full text.

If you modify URGE and run it as a network service, AGPL-3.0 requires that you also make the corresponding source code available to users of that service.

## Citing URGE

If you use URGE in your work, please cite it. Citation metadata is available in
[`CITATION.cff`](CITATION.cff), and GitHub's "Cite this repository" button will
generate BibTeX and APA formats from it.
