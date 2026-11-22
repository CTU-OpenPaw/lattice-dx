/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
function registerSampleApplications(catalog) {
  catalog.register(require('../shared/manifests/purchasing.json'));
  catalog.register(require('../shared/manifests/logistics.json'));
  catalog.register(require('../shared/manifests/work.json'));
  catalog.register(require('../shared/manifests/incident.json'));
}
module.exports={registerSampleApplications};
