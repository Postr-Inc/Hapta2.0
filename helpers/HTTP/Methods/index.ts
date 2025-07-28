// A base type that all database records must have.
export type BaseRecord = {
    id: string;
    cacheKey: string,
    collectionName: string,
    collectionId: string
};

// Data for creating a new record, which is the full object minus the 'id'.
export type CreateData<T> = Omit<T, 'id'>;

// A robust options object for querying lists of items.
export type QueryOptions<T> = {
    // Example: { name: 'Hapta', version: 2 }
    filter?: Partial<T>;
    sort?: {
        field: keyof T;
        direction: 'asc' | 'desc';
    };
    pagination?: {
        limit: number;
        offset: number;
    };
};

// A fully-typed, generic, and async interface for database operations.
export type Database = {
    /** Gets a single item by its ID. */
    get<T extends BaseRecord>(collection: string, id: string): Promise<T | null>;

    /** Gets multiple items using a flexible query. */
    list<T extends BaseRecord>(collection: string, options?: QueryOptions<T>): Promise<T[]>;
    
    /** Creates a new item in the database. */
    create<T extends BaseRecord>(collection: string, data: CreateData<T>): Promise<T>;

    /** Updates an existing item by its ID. */
    update<T extends BaseRecord>(collection: string, id: string, data: Partial<CreateData<T>>): Promise<T>;

    /** Deletes an item by its ID. */
    delete(collection: string, id: string): Promise<void>;
};