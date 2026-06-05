(function (root, factory) {
  var api = factory();
  root.InstructionStudioRuleModel = api;
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function normalizeText(value) {
    return String(value || '').trim();
  }

  function parseEnabled(value) {
    if (!value || typeof value !== 'object') {
      return true;
    }
    if (typeof value.enabled === 'boolean') {
      return value.enabled;
    }
    if (typeof value.active === 'boolean') {
      return value.active;
    }
    return true;
  }

  function toRuleItem(value) {
    if (value && typeof value === 'object') {
      return {
        text: normalizeText(value.text || value.label || ''),
        enabled: parseEnabled(value),
      };
    }
    return {
      text: normalizeText(value),
      enabled: true,
    };
  }

  function normalizeRuleItems(nextRules, fallbackText) {
    var rules = Array.isArray(nextRules)
      ? nextRules.map(toRuleItem).filter(function (item) { return item.text.length > 0; })
      : [];
    if (rules.length === 0) {
      rules = [{ text: normalizeText(fallbackText), enabled: true }];
    }
    return rules;
  }

  function fromGraphNodes(nodes, fallbackText) {
    var nextRules = Array.isArray(nodes)
      ? nodes
          .filter(function (node) { return node && typeof node === 'object' && node.type === 'rule'; })
          .map(function (node) {
            return {
              text: normalizeText(node.text || node.label || ''),
              active: node.active,
            };
          })
      : [];
    return normalizeRuleItems(nextRules, fallbackText);
  }

  function toGraphRuleSpecs(ruleItems, fallbackText) {
    return normalizeRuleItems(ruleItems, fallbackText).map(function (item) {
      return {
        text: item.text,
        active: item.enabled !== false,
      };
    });
  }

  return {
    normalizeRuleItems: normalizeRuleItems,
    fromGraphNodes: fromGraphNodes,
    toGraphRuleSpecs: toGraphRuleSpecs,
  };
});
