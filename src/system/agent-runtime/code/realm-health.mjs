/** Only startup recovery skips an unavailable realm; interactive own-account reads still fail explicitly. */
export function recoveryRows(store,accountId,collection){try{return store.list(accountId,collection)}catch(error){if(error.status===503)return[];throw error}}
