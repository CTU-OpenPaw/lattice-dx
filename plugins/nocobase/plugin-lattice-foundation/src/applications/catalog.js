// SPDX-License-Identifier: Apache-2.0
function registerSampleApplications(catalog) {
  catalog.register(require('../shared/manifests/purchasing.json'));
  catalog.register(require('../shared/manifests/logistics.json'));
  catalog.register(require('../shared/manifests/work.json'));
}
module.exports={registerSampleApplications};
