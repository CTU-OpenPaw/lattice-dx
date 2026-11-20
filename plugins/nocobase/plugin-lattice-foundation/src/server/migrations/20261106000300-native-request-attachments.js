/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const { Migration } = require('@nocobase/server');

class NativeRequestAttachments extends Migration {
  on = 'afterSync';

  async up() {
    await this.context.db.sequelize.query(`
      CREATE TABLE IF NOT EXISTS lattice_native_request_attachments (
        id uuid PRIMARY KEY,
        request_id bigint NOT NULL REFERENCES "latticeRequests" (id) ON DELETE CASCADE,
        organization_id varchar(255) NOT NULL,
        uploader_id bigint NOT NULL,
        idempotency_key uuid NOT NULL,
        filename varchar(200) NOT NULL,
        content bytea NOT NULL CHECK (octet_length(content) BETWEEN 1 AND 1048576),
        UNIQUE (request_id, organization_id, uploader_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS lattice_native_request_attachments_scope
        ON lattice_native_request_attachments (request_id, organization_id, id);
    `);
  }
}

module.exports = NativeRequestAttachments;
module.exports.default = NativeRequestAttachments;
