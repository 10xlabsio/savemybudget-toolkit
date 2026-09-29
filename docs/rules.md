# Detection rules

Ten rules, each documented with what it looks for, the default it ships with, what it needs, and where it produces false positives. The defaults are conservative starting points, not tuned values; the managed version runs additional rules and calibrates thresholds per account, and none of that is in this repository.

Every click gets a verdict: **allow**, **watch** or **flag**. A **hard** rule flags on its own. **Soft** rules add to a score, and a click is only flagged when the score crosses the threshold **and at least two independent layers agree**. That convergence guard is deliberate: a single soft signal is how real customers get flagged.

Defaults live in `src/rules/defaults.json`. Changing them is a product decision, not a code change — open a discussion before a pull request.

## Network

### 1. Datacenter / hosting network — hard

The visitor's IP belongs to a hosting provider's network (AWS, Google Cloud, Hetzner, OVH, DigitalOcean and others). Real customers don't browse from datacenters. The list is `data/hosting-asns.txt`; additions are welcome, with a source.

Needs: any source. False positives: corporate VPNs terminating in a cloud region; a few residential ISPs share address space with hosting arms. Keep the list to networks that are hosting-only.

### 3. Outside targeting — hard when targeting is set

The IP's country is not in the countries the campaign targets. Only runs if you set targeting countries on the site; off otherwise.

Needs: any source, targeting set. False positives: travellers, VPN users, IP geolocation errors near borders. Google's own filters usually handle this; it's here for completeness and for the IP list.

### 4. Subnet clustering — soft

Five or more distinct IPs from the same /24 within 15 minutes. One network sending a burst of "different" visitors.

Needs: any source. False positives: large offices and universities behind a NAT range; mobile carrier CGNAT. Dampened when the user-agent mix on the range is diverse.

## Browser

### 6. Automation markers — hard

The browser announces itself as automated: `navigator.webdriver` set, a HeadlessChrome or PhantomJS user agent, no plugins or fonts where a real browser would have them. From logs, only the user-agent check runs.

Needs: beacons (full), log/CSV (user-agent only). False positives: rare; some accessibility and monitoring tools run headless browsers against their own sites — exclude your own monitoring IPs.

### 8. Fingerprint collision — soft

The same browser fingerprint hash seen from five or more IPs within 24 hours. One machine cycling through addresses.

Needs: beacons. False positives: identical corporate builds behind different NAT exits; privacy browsers that deliberately flatten fingerprints. Convergence with a network or behaviour signal is required before this flags.

### 9. Request seen, no beacon — hard, with a guard

A request with a click ID reached your server, but the tag never sent a beacon for it: the visitor didn't run JavaScript. Bots that fetch the URL and leave look exactly like this. Real browsers almost never do.

Needs: beacons **and** a server log for the same site and window. Guard: if the site's beacon volume drops sharply relative to its own history (tag removed, consent banner change, outage), the rule downgrades to soft for that window and says so in the analysis. Otherwise a broken install would flag everything.

## Behaviour

### 10. Zero-dwell bounce — soft

The page was closed within two seconds with no interaction. Measured on visible time, so a page opened in a background tab and never viewed does not count as a bounce.

Needs: beacons. False positives: mis-clicks, very slow pages. Never flags alone.

### 11. Dead session — soft

Zero mouse, scroll or touch events for the whole session. A page was loaded and nothing happened.

Needs: beacons. False positives: users who read a short page and leave; assistive technologies. Never flags alone.

### 13. Click ID replay — hard

The same click ID hit the landing page two or more times, or arrived more than 24 hours after it was first seen. A click ID is minted once per real click; reuse means a URL is being replayed.

Needs: any source. False positives: a visitor reloading the landing page or returning via browser history. The threshold is set so an ordinary reload is tolerated; repeated hits over hours are not.

## Frequency

### 14. IP velocity — soft

Three or more paid clicks from one IP in 15 minutes, or five or more in 24 hours. Halved in weight when the IP shows five or more distinct browser families in the window, which is what carrier-grade NAT and office networks look like.

Needs: any source. False positives: exactly those shared networks — hence the dampener and the convergence guard.

## What's not here

Rules that need behavioural modelling (mouse-path analysis), proxy and VPN lists (noisy without curation), economic rules that need your Google Ads cost data, and cross-account signals (an address flagged on many sites at once). Those run in the managed version and depend on data that doesn't ship in a repository.

## Reading an analysis

The analysis page lists each rule with how many clicks it fired on and a one-line description. Present flagged clicks to Google as observations: "42 visits from one hosting network, median visible time 0.4 s, no interaction." The toolkit decides what to flag; Google decides what is invalid.
