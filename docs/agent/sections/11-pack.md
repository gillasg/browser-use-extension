## Moving a site to another machine

```sh
browserkit pack export shop.example --out shop.zip
browserkit pack import shop.zip
browserkit pack enable shop.example
```

A pack holds the mapped site (model, OpenAPI, typed client and recorded flows) and the browser
skills and boosts written for it. Export strips sessions, cookies and credential-bearing request
headers and bodies. Import writes the site but saves skills and boosts **disabled** and prints their
code; review it, then enable them. Without the browser running, boosts are left out (export) or not
saved (import); the site and skills still move.
