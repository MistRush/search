import { Meilisearch } from 'meilisearch';

const client = new Meilisearch({
    host: 'http://127.0.0.1:7700'
});

async function main() {
    const index = (client as any).index('products');

    console.log("Updating settings...");
    const task = await index.updateSettings({
        searchableAttributes: [
            'title',
            'brand',
            'category_hierarchy'
        ],
        filterableAttributes: [
            'category_hierarchy',
            'brand',
            'price',
            'category_id',
            'stock'
        ],
        sortableAttributes: [
            'price',
            'stock'
        ]
    });

    console.log("Waiting for settings update task...", task.taskUid);
    await client.waitForTask(task.taskUid);
    console.log("Settings updated successfully!");
}

main().catch(console.error);
