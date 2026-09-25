# Realtor App (working title)

iOS + web app for the parties in a real-estate transaction. The realtor is the
central user; buyers/sellers they represent are the other parties.

- **Name is TBD** — "Realtor App" is a placeholder display name.
- iOS is the real product (Expo SDK 57, EAS builds → TestFlight).
- Web is the test surface: https://anurajshetty.github.io/realtor-app/
- Same build/deploy process as the Willow app.

## Deploy the web test build

```sh
npm run export:web        # WEB_DEPLOY=1 expo export --platform web
python3 scripts/deploy_gh_pages.py
```
