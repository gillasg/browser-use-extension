## Blocked sites

Sites the user blocked are off limits in every way: no tab opens them, `browser.fetch` and site API
calls refuse them, and clicks, redirects or scripts inside a working tab cannot reach them. A call
that touches one fails with `SITE_BLOCKED`: stop, and tell the user if the task needs it. Only the
user changes the list, with `browserkit block|unblock|blocked`.
