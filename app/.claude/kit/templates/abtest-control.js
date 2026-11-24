// Control code template: removes the test attributes so control visitors get the normal checkout.
// Setting a cart attribute to "" deletes it.
(() => {
  var ID = "TICKET"; // e.g. "BOD-398"
  var ATTR = `_${ID.toLowerCase()}`;
  var KEYS = [ATTR, `${ATTR}_device_type`]; // same keys as the variation

  async function clearCartAttributes() {
    try {
      const cart = await (await fetch("/cart.js")).json();
      const attrs = cart.attributes || {};
      const present = KEYS.filter((key) => key in attrs);
      if (!present.length) {
        return;
      }
      await fetch("/cart/update.js", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attributes: Object.fromEntries(present.map((key) => [key, ""])) })
      });
    } catch (error) {
      console.log(`${ID} control error`, error);
    }
  }
  clearCartAttributes();
})();
