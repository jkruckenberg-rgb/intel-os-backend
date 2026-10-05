# INTEL·OS Backend Sweeper

Automated opportunity intelligence server for JK Consulting, LLC.

## What it does
- Proxies SAM.gov API calls (fixes CORS in the browser app)
- Runs scheduled sweeps every 6 hours across:
  - SAM.gov federal opportunities
  - Maryland eMMA state procurement portal
  - Virginia eVA procurement portal
  - DC Office of Contracting and Procurement
- Scores each opportunity for JK Consulting fit (0–100%)
- Emails digest to jkruckenberg@jkconsultsllc.com when high-probability matches found
- Includes EVA-drafted letters of interest in each email

## Setup on Railway

Set these environment variables in Railway dashboard:

| Variable | Value |
|----------|-------|
| `SAM_API_KEY` | Your SAM.gov API key |
| `NOTIFY_EMAIL` | jkruckenberg@jkconsultsllc.com |
| `SMTP_HOST` | smtp.gmail.com |
| `SMTP_PORT` | 587 |
| `SMTP_USER` | Your Gmail address |
| `SMTP_PASS` | Your Gmail App Password |
| `FROM_EMAIL` | intel-os@jkconsultsllc.com |

## API Endpoints

- `GET /health` — Server status
- `GET /api/sam/opportunities` — SAM.gov proxy (pass `X-Api-Key` header)
- `GET /api/sweep/results` — Last sweep results
- `POST /api/sweep/run` — Trigger manual sweep
