/**
 * Experiment registry.
 * Experiments call VL.registerExperiment(def) at load time; the UI looks them up by id.
 * See docs/ARCHITECTURE.md §4 for the experiment contract.
 */
(function (VL) {
  'use strict';

  var REQUIRED = ['id', 'title', 'seedPrefix', 'variants', 'sampleParams', 'quantities',
    'paper', 'rubric', 'modelAnswer', 'createApparatus'];

  VL.experimentsById = VL.experimentsById || {};
  VL.experimentOrder = VL.experimentOrder || [];

  /**
   * Register an experiment definition.
   * @param {object} def experiment definition (see contract)
   * @returns {object} the definition
   */
  VL.registerExperiment = function (def) {
    if (!def || typeof def !== 'object') throw new Error('registerExperiment: definition required');
    REQUIRED.forEach(function (k) {
      if (def[k] === undefined) throw new Error('registerExperiment(' + (def.id || '?') + '): missing "' + k + '"');
    });
    if (!Array.isArray(def.variants) || def.variants.length === 0) {
      throw new Error('registerExperiment(' + def.id + '): variants must be a non-empty array');
    }
    def.variants.forEach(function (v) {
      if (!v.id || (v.style !== 'Q1' && v.style !== 'Q2')) {
        throw new Error('registerExperiment(' + def.id + '): each variant needs id and style Q1|Q2');
      }
    });
    if (!VL.experimentsById[def.id]) VL.experimentOrder.push(def.id);
    VL.experimentsById[def.id] = def;
    return def;
  };

  /** @returns {object|null} */
  VL.getExperiment = function (id) {
    return VL.experimentsById[id] || null;
  };

  /**
   * List experiments, optionally only those having a variant of the given style.
   * @param {{style?: 'Q1'|'Q2'}} [filter]
   */
  VL.listExperiments = function (filter) {
    var list = VL.experimentOrder.map(function (id) { return VL.experimentsById[id]; });
    if (filter && filter.style) {
      list = list.filter(function (e) {
        return e.variants.some(function (v) { return v.style === filter.style; });
      });
    }
    return list;
  };

  /** Find a variant definition. */
  VL.getVariant = function (exp, variantId) {
    if (!exp) return null;
    for (var i = 0; i < exp.variants.length; i++) {
      if (exp.variants[i].id === variantId) return exp.variants[i];
    }
    return null;
  };
})(globalThis.VLab = globalThis.VLab || {});
