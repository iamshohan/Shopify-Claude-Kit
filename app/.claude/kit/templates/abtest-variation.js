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

  async function changeCartJS() {
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
      const updateRes = await fetch("/cart/update.js", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attributes: { ...existingAttrs, ...wanted } })
      });
      const updatedCart = await updateRes.json();
      expLog("Updated cart attributes:", updatedCart.attributes);
    } catch (error) {
      expLog("Error:", error);
    }
  }

  // Re-check when the cart changes. Prefer a theme cart event if the theme has one
  // (e.g. document.addEventListener("cart:updated", changeCartJS)); otherwise observe the drawer.
  function handleMutation() {
    poll(
      () => q("cart-drawer"),
      (base) => {
        const observer = new MutationObserver(() => changeCartJS());
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
