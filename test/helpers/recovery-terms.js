'use strict';
const {randomUUID}=require('node:crypto');

module.exports=async function acceptTestTerms(db,customerId) {
    const {rows:[user]}=await db.query(`INSERT INTO platform_users(customer_id,email,display_name,password_hash,role)
        VALUES($1,$2,'Synthetic terms admin','not-a-real-password','admin') RETURNING id`,[customerId,`${randomUUID()}@example.invalid`]);
    const terms=require('../../src/recovery/terms');
    await terms.accept(customerId,user.id,{accepted:true,version:terms.document.version,hash:terms.hash});
};
