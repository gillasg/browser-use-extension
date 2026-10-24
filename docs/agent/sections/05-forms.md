## Forms and overlays

Clear cookie banners and pop-ups first: `page.overlays.dismiss()`. Use the site's own search,
filters and sort (or its filter URL once seen). Autocomplete fields: type, wait for the suggestion
list, then click the matching option; read each field's value back before the next.

`page.controls.inspect()` gives every field's state; `page.batch(steps)` fills, selects, checks and
submits in one call, ending with a read of the result (`help("forms")`). `TARGET_BLOCKED` names what
covers the control: act inside that dialog or close it. If something seems missing, scroll, search
the page or try another URL before concluding it is not there. Never repeat a failing action more
than twice; change strategy.
