// Optional feed thumbnails. Apply during a normal PocketBase migration/startup
// window after taking a stopped-service pb_data backup. Originals remain in
// `file` and are never rewritten.
const thumbnailFields = [
  {
    system: false,
    id: 'thumbfile01',
    name: 'thumbnail',
    type: 'file',
    required: false,
    presentable: false,
    unique: false,
    options: {
      mimeTypes: ['image/webp', 'image/jpeg', 'image/png'],
      thumbs: [],
      maxSelect: 1,
      maxSize: 204800,
      protected: false,
    },
  },
  {
    system: false,
    id: 'thumbwidth1',
    name: 'thumbnail_width',
    type: 'number',
    required: false,
    presentable: false,
    unique: false,
    options: { min: null, max: 480, noDecimal: true },
  },
  {
    system: false,
    id: 'thumbheight1',
    name: 'thumbnail_height',
    type: 'number',
    required: false,
    presentable: false,
    unique: false,
    options: { min: null, max: 480, noDecimal: true },
  },
  {
    system: false,
    id: 'thumbmime1',
    name: 'thumbnail_mime',
    type: 'text',
    required: false,
    presentable: false,
    unique: false,
    options: { min: null, max: 64, pattern: '' },
  },
  {
    system: false,
    id: 'thumbsize1',
    name: 'thumbnail_size',
    type: 'number',
    required: false,
    presentable: false,
    unique: false,
    options: { min: 0, max: 204800, noDecimal: true },
  },
];

const collectionIds = ['bamkouxzblg8dmr', '10s38ry89mxm4ub'];

migrate((db) => {
  const dao = new Dao(db);
  for (const collectionId of collectionIds) {
    const collection = dao.findCollectionByNameOrId(collectionId);
    for (const field of thumbnailFields) {
      if (!collection.schema.getFieldByName(field.name)) {
        collection.schema.addField(new SchemaField(field));
      }
    }
    dao.saveCollection(collection);
  }
}, (db) => {
  const dao = new Dao(db);
  for (const collectionId of collectionIds) {
    const collection = dao.findCollectionByNameOrId(collectionId);
    for (const field of thumbnailFields) {
      collection.schema.removeField(field.id);
    }
    dao.saveCollection(collection);
  }
});
