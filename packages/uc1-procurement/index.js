// SPDX-License-Identifier: Apache-2.0
'use strict';

const purchasing = require('./manifests/purchasing.json');
const work = require('./manifests/work.json');
const workflowBundle = require('./manifests/workflow-bundle.json');

const packageInfo = {
  name: '@latticedx/uc1-procurement',
  version: '1.0.0',
  useCase: 'UC1: Mua sắm & Bàn giao tài sản',
  schemaVersion: 1
};

function getPackageManifest() {
  return {
    ...packageInfo,
    applications: [
      { id: purchasing.id, name: purchasing.name, manifest: purchasing },
      { id: work.id, name: work.name, manifest: work }
    ],
    workflowBundle
  };
}

module.exports = {
  packageInfo,
  purchasing,
  work,
  workflowBundle,
  getPackageManifest
};

if (require.main === module) {
  const pkg = getPackageManifest();
  console.log(`UC1 Package '${pkg.name}' v${pkg.version} loaded successfully with ${pkg.applications.length} applications and 1 workflow bundle.`);
}
