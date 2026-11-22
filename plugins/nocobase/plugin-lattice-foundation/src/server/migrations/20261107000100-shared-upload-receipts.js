/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const {Migration}=require('@nocobase/server');
class SharedUploadReceipts extends Migration{
  on='afterSync';
  async up(){
    await this.context.db.sequelize.query(`CREATE TABLE IF NOT EXISTS lattice_native_request_uploads(
      request_id bigint NOT NULL REFERENCES "latticeRequests"(id) ON DELETE CASCADE,
      organization_id varchar(255) NOT NULL,
      uploader_id bigint NOT NULL,
      upload_key uuid NOT NULL,
      filename varchar(200) NOT NULL,
      content_digest char(64) NOT NULL,
      state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','complete','failed')),
      attempts integer NOT NULL DEFAULT 1 CHECK(attempts>=1),
      result jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(request_id,organization_id,uploader_id,upload_key)
    ); CREATE UNIQUE INDEX IF NOT EXISTS lattice_native_one_pending_upload
      ON lattice_native_request_uploads(request_id,organization_id) WHERE state='pending';`);
  }
  async down(){
    await this.context.db.sequelize.query(`DROP TABLE IF EXISTS lattice_native_request_uploads;`);
  }
}
module.exports=SharedUploadReceipts;
module.exports.default=SharedUploadReceipts;
