import { MeiliSearch } from 'meilisearch';
import { XMLParser } from 'fast-xml-parser';
import * as https from 'https';
import * as dotenv from 'dotenv';
import * as fs from 'fs';

dotenv.config();

// Initialize Meilisearch client (default local address)
const client = new MeiliSearch({
    host: process.env.MEILI_HOST || 'http://127.0.0.1:7700',
    apiKey: process.env.MEILI_MASTER_KEY || '',
});

// XML Parser for Categories
const categoryParser = new XMLParser({
    ignoreAttributes: false,
});

// A stream utility to download XML directly to a string or stream it
async function downloadXml(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            if (res.statusCode !== 200) {
                return reject(new Error(`Failed to download: ${res.statusCode}`));
            }

            // We need to handle windows-1250 realistically. For now we will just read chunks.
            // Node's native handling might mangle special chars without proper decoding.
            // A more robust solution might use `iconv-lite`, but for testing we'll assume basic parsing holds.
            let data = Buffer.alloc(0);
            res.on('data', (chunk) => {
                data = Buffer.concat([data, chunk]);
            });
            res.on('end', () => {
                // simple decoding fallback
                const decoder = new TextDecoder('windows-1250');
                resolve(decoder.decode(data));
            });
        }).on('error', reject);
    });
}

async function main() {
    console.log("Starting E-shop XML parser...");

    // 1. Process Categories
    console.log("Downloading categories...");
    const catXmlStr = await downloadXml('https://www.hadex.cz/hadexstrom_ai.xml');
    const catParsed = categoryParser.parse(catXmlStr);

    // Create a map to look up category info by ID
    const categoryMap = new Map<string, any>();
    if (catParsed?.CATEGORIES?.CATEGORY) {
        const cats = Array.isArray(catParsed.CATEGORIES.CATEGORY) ? catParsed.CATEGORIES.CATEGORY : [catParsed.CATEGORIES.CATEGORY];
        for (const cat of cats) {
            categoryMap.set(cat.ID, cat);
        }
    }
    console.log(`Loaded ${categoryMap.size} categories.`);

    // 2. Process Products
    console.log("Downloading products...");
    const productXmlStr = await downloadXml('https://www.hadex.cz/hadexzbozi_ai.xml');

    // For products, we want to parse it just as we did above
    // Note: fast-xml-parser can handle quite large files in memory, but if it fails we would need streaming.
    // Given the previous partial tests, this file is typical e-shop size and likely manageable.
    const productParser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: "@_"
    });

    const prodParsed = productParser.parse(productXmlStr);
    let items = [];
    if (prodParsed?.PRODUCTS?.PRODUCT) {
        items = Array.isArray(prodParsed.PRODUCTS.PRODUCT) ? prodParsed.PRODUCTS.PRODUCT : [prodParsed.PRODUCTS.PRODUCT];
    }

    console.log(`Loaded ${items.length} products. Processing and enrichening...`);

    const documentsToInsert = items.map((prod: any) => {
        // Find category hierarchy
        let catId = null;
        let catHierarchy = null;

        let categories = prod.CATEGORIES?.CATEGORY;
        if (categories) {
            // It could be an array of categories
            const mainCat = Array.isArray(categories) ? categories[0] : categories;
            if (mainCat && mainCat["@_id"]) {
                catId = mainCat["@_id"];
                const catObj = categoryMap.get(catId);
                if (catObj) {
                    catHierarchy = catObj.HIERARCHY;
                }
            }
        }

        // Return the schema Meilisearch will index
        return {
            id: prod.ITEM_ID, // required for Meilisearch
            title: prod.TITLE,
            brand: prod.BRAND,
            url: prod.URL,
            image: prod.IMG,
            price: parseFloat(prod.VAT_PRICE) || 0,
            price_ex_vat: parseFloat(prod.PRICE) || 0,
            price_b2b_1: parseFloat(prod.VAT_PRICE_B2B_1) || 0,
            price_b2b_2: parseFloat(prod.VAT_PRICE_B2B_2) || 0,
            price_b2b_3: parseFloat(prod.VAT_PRICE_B2B_3) || 0,
            stock: parseInt(prod.STOCK, 10) || 0,
            stock_info: prod.STOCK_INFO,
            category_id: catId,
            category_hierarchy: catHierarchy
        };
    });

    console.log(`Submitting ${documentsToInsert.length} documents to Meilisearch...`);
    const index = client.index('products');

    try {
        const task = await index.addDocuments(documentsToInsert, { primaryKey: 'id' });
        console.log(`Documents added to index queue! Task ID: ${task.taskUid}`);

        console.log("Waiting for indexing to complete...");
        await client.waitForTask(task.taskUid);
        console.log("Indexing finished successfully!");

    } catch (e: any) {
        console.error("Error during indexing:", e);
    }
}

main().catch(console.error);
