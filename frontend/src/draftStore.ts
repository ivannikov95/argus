const DB_NAME = "argus-local";
const STORE_NAME = "workspace";
const DRAFT_KEY = "current-draft";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transact<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>) {
  const database = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const request = action(transaction.objectStore(STORE_NAME));
    let result: T;
    request.onsuccess = () => { result = request.result; };
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => { database.close(); resolve(result); };
    transaction.onerror = () => reject(transaction.error);
  });
}

export const loadWorkspaceDraft = <T>() => transact<T | undefined>("readonly", (store) => store.get(DRAFT_KEY));
export const saveWorkspaceDraft = <T>(draft: T) => transact<IDBValidKey>("readwrite", (store) => store.put(draft, DRAFT_KEY));
export const clearWorkspaceDraft = () => transact<undefined>("readwrite", (store) => store.delete(DRAFT_KEY));
