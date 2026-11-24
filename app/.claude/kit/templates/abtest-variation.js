// Variation code template (from the team's abtest-checkout-extension skill, based on BOD-398 variation 1). Replace TICKET / VAR / test name and the attribute set.
(() => {
  function poll(condition, callback, persistent = false, timeout = 1e4, pollInterval = 25) {
    if (condition()) {
      callback(condition());
    } else if (timeout > 0) {
      setTimeout(() => {
        poll(condition, callback, persistent, persistent ? timeout : timeout - pollInterval, pollInterval);
      }, pollInterval);
    }
  }
  function q(s, o) {
    return o ? s.querySelector(o) : document.querySelector(s);
  }

  var ID = "TICKET"; // e.g. "BOD-398"
  var VAR = "1";
  var ATTR = `_${ID.toLowerCase()}`; // "_bod-398"
  function expLog() {
    window.runningExperiments[ID].logs.push([...arguments]);
  }

  function testInfo(testName) {
    window.runningExperiments = window.runningExperiments || {};
    window.runningExperiments[ID] = {
      name: testName || "",
      variation: `${VAR}`,
      logs: []
    };
    poll(
      () => q("body"),
      () => {
        q("body").classList.add(`${ID}`, `${ID}_${VAR}`);
        expLog("RUNNING EXPERIMENT: ", ID, " :: ", VAR);
      }
    );
  }

  // Only the attributes the task needs. Remove device_type if the task is not device dependent.
  function wantedAttributes() {
    return {
      [ATTR]: "true",
      [`${ATTR}_device_type`]: window.innerWidth > 768 ? "desktop" : "mobile"
    };
  }

  // One write at a time, at most MAX_WRITES per page: a theme or app that rewrites attributes can't start a loop.
  var MAX_WRITES = 3;
  var writes = 0;
  var busy = false;
  var timer = null;

  async function changeCartJS() {
    if (busy || writes >= MAX_WRITES) return;
    busy = true;
    try {
      const res = await fetch("/cart.js");
      const cart = await res.json();
      if (!(cart.item_count > 0)) {
        return;
      }
      const existingAttrs = cart.attributes || {};
      const wanted = wantedAttributes();
      if (Object.keys(wanted).every((key) => existingAttrs[key] === wanted[key])) {
        expLog("Cart attributes already correct");
        return;
      }
      writes++;
      // Only this test's keys: posting back the whole (possibly stale) set could overwrite another app's attribute.
      const updateRes = await fetch("/cart/update.js", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attributes: wanted })
      });
      const updatedCart = await updateRes.json();
      expLog("Updated cart attributes:", updatedCart.attributes);
    } catch (error) {
      expLog("Error:", error);
    } finally {
      busy = false;
    }
  }

  function scheduleCheck() {
    clearTimeout(timer);
    timer = setTimeout(changeCartJS, 300);
  }

  // Re-check when the cart changes: the theme's cart event if it has one (check the theme first, e.g.
  // document.addEventListener("cart:updated", scheduleCheck)), any add or change through fetch, and the drawer if present.
  function handleMutation() {
    const origFetch = window.fetch;
    window.fetch = function () {
      const url = String((arguments[0] && arguments[0].url) || arguments[0] || "");
      const p = origFetch.apply(this, arguments);
      if (/\/cart\/(add|change)(\.js)?/.test(url)) p.then(scheduleCheck, () => {});
      return p;
    };
    poll(
      () => q("cart-drawer"),
      (base) => {
        const observer = new MutationObserver(scheduleCheck);
        observer.observe(base, { attributes: true, childList: true });
      }
    );
  }

  function mainJS() {
    testInfo("TEST NAME");
    changeCartJS();
    handleMutation();
  }
  mainJS();
})();
