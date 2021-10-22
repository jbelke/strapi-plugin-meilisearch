const {
  isCollectionACompositeIndex,
  numberOfRowsInCollection,
  getMultiEntriesCollections,
  fetchRowBatch,
  getIndexName,
} = require('./../services/collection')

module.exports = async ({
  clientService,
  meilisearchService,
  storeService,
  storeClient,
  models,
}) => {
  console.log({ storeClient })
  console.log({ storeService })

  const store = storeService(storeClient)
  const apiKey = await store.getStoreKey('meilisearch_api_key')
  const host = await store.getStoreKey('meilisearch_host')
  const client = clientService({ apiKey, host })
  const meilisearch = meilisearchService(client)

  return {
    meilisearch,
    addCredentials: async function ({ host, apiKey }) {
      const {
        configFileApiKey,
        configFileHost,
      } = await this.resolveClientCredentials()
      if (!configFileApiKey) {
        await store.setStoreKey({
          key: 'meilisearch_api_key',
          value: apiKey,
        })
      }
      if (!configFileHost) {
        await store.setStoreKey({
          key: 'meilisearch_host',
          value: host,
        })
      }
      return this.resolveClientCredentials()
    },
    updateStoreCredentials: async function (plugins) {
      // optional chaining is not natively supported by node 12.
      let apiKey = false
      let host = false

      if (plugins && plugins.meilisearch) {
        apiKey = plugins.meilisearch.apiKey
        host = plugins.meilisearch.host
      }

      if (apiKey) {
        await store.setStoreKey({
          key: 'meilisearch_api_key',
          value: apiKey,
        })
      }
      await store.setStoreKey({
        key: 'meilisearch_api_key_config',
        value: !!apiKey,
      })

      if (host) {
        await store.setStoreKey({
          key: 'meilisearch_host',
          value: host,
        })
      }
      await store.setStoreKey({
        key: 'meilisearch_host_config',
        value: !!host,
      })
    },

    resolveClientCredentials: async function () {
      const apiKey = await store.getStoreKey('meilisearch_api_key')
      const host = await store.getStoreKey('meilisearch_host')
      const configFileApiKey =
        (await store.getStoreKey('meilisearch_api_key_config')) || false
      const configFileHost =
        (await store.getStoreKey('meilisearch_host_config')) || false
      return { apiKey, host, configFileApiKey, configFileHost }
    },
    deleteIndex: async function (collection) {
      await meilisearch.deleteIndex({
        indexUid: getIndexName(collection, models),
      })
    },
    deleteEntriesFromMeiliSearch: async function ({ collection, entriesId }) {
      await meilisearch.deleteDocuments({
        indexUid: getIndexName(collection, models),
        documentIds: entriesId,
      })
    },
    waitForCollectionIndexation: async function (collection) {
      const numberOfDocuments = await meilisearch.waitForPendingUpdates({
        indexUid: getIndexName(collection, models),
        updateNbr: 2,
      })
      return { numberOfDocuments }
    },
    getCollectionsReport: async function () {
      const indexes = await meilisearch.getIndexes()
      const watchedCollections = await this.getWatchedCollections()
      const multiRowsCollections = getMultiEntriesCollections()
      const collections = multiRowsCollections.map(async collection => {
        const indexUid = getIndexName(collection, models)

        const existInMeilisearch = !!indexes.find(
          index => index.name === indexUid
        )
        const { numberOfDocuments = 0, isIndexing = false } = existInMeilisearch
          ? await meilisearch.getStats({ indexUid })
          : {}

        const numberOfRows = await numberOfRowsInCollection(collection)
        return {
          collection,
          indexUid,
          indexed: existInMeilisearch,
          isIndexing,
          numberOfDocuments,
          numberOfRows,
          hooked: watchedCollections.includes(collection),
        }
      })
      return { collections: await Promise.all(collections) }
    },
    addOneEntryInMeiliSearch: async function ({ collection, entry }) {
      if (!Array.isArray(entry)) {
        entry = [entry]
      }
      return meilisearch.addDocuments({
        indexUid: getIndexName(collection, models),
        data: this.transformEntries(collection, entry),
      })
    },
    addCollectionInMeiliSearch: async function (collection) {
      await meilisearch.createIndex({
        indexUid: getIndexName(collection, models),
      })
      const entries_count = await numberOfRowsInCollection(collection)
      const BATCH_SIZE = 1000
      const updateIds = []

      for (let index = 0; index <= entries_count; index += BATCH_SIZE) {
        const entries =
          (await fetchRowBatch({
            start: index,
            limit: BATCH_SIZE,
            collection,
          })) || []

        const indexUid = getIndexName(collection, models)
        const { updateId } = await meilisearch.addDocuments({
          indexUid,
          data: this.transformEntries(collection, entries),
        })

        if (updateId) updateIds.push(updateId)
      }
      return { updateIds }
    },
    updateCollectionInMeiliSearch: async function (collection) {
      // Delete whole index only if the index is not a composite index
      if (collection === getIndexName(collection, models)) {
        const { updateId } = await meilisearch.deleteAllDocuments({
          indexUid: getIndexName(collection, models),
        })
        await meilisearch.waitForPendingUpdate({
          updateId,
          indexUid: getIndexName(collection, models),
        })
      }
      return this.addCollectionInMeiliSearch(collection)
    },
    removeCollectionFromMeiliSearch: async function (collection) {
      const isCompositeIndex = isCollectionACompositeIndex(collection, models)

      if (!isCompositeIndex) {
        await meilisearch.deleteIndex({
          indexUid: getIndexName(collection, models),
        })
      } else {
        // TODO if composite
        await meilisearch.deleteIndex({
          indexUid: getIndexName(collection, models),
        })
      }
      return { message: 'ok' }
    },
    getWatchedCollections: async function () {
      const collections = await store.getStoreKey('meilisearch_hooked')
      return collections || []
    },
    createWatchedCollectionsStore: async function () {
      return store.setStoreKey({ key: 'meilisearch_hooked', value: [] })
    },
    addWatchedCollectionToStore: async function (collections) {
      store.setStoreKey({
        key: 'meilisearch_hooked',
        value: collections,
      })
    },
    getIndexUidsOfIndexedCollections: async function (collections) {
      // get list of indexes in MeiliSearch Instance
      let indexes = await meilisearch.getIndexes()
      indexes = indexes.map(index => index.uid)
      return collections.filter(collection =>
        indexes.includes(getIndexName(collection, models))
      )
    },
    /**
     * @brief Convert a mode instance into data structure used for indexing.
     *
     * @param indexUid - This is will equal to model's name
     * @param data {Array|Object} - The data to convert. Conversion will use
     * the static method `toSearchIndex` defined in the model definition
     *
     * @return {Array|Object} - Converted or mapped data
     */
    transformEntries: function (collection, entries) {
      const model = models[collection]
      const mapFunction = model.toSearchIndex
      if (!(mapFunction instanceof Function)) {
        return entries
      }
      if (Array.isArray(entries)) {
        entries.map(mapFunction)
        return entries.map(mapFunction)
      }
      return mapFunction(entries)
    },
  }
}
