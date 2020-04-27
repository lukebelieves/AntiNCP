'use strict';
const chalk = require('chalk');
const ProgressBar = require('progress');
const debug = require('debug')('backend:analyze');
const db = require('../database');
const tuple = require('../utils/tuple');
const {getPageRank} = require('../fetch/third-party/articles');
require('./preprocess'); // register `tokenize`, `stem` & `tokenizeAndStem` method
const ID_STEP = 1000;

/**
 * Preprocess articles into stemmed tokens **in place**
 * @param articles{Object[]}
 * @param cb{function(string, string)} callback on stemming a word, e.g. to document the word-stem pair in db
 * @return {Object[]}
 */
function preprocessArticles(articles, cb = null) {
    articles.forEach(article => {
        article.tokens = article.title.tokenizeAndStem(cb)
            .concat(article.content.tokenizeAndStem(cb));
        article.pagerank = getPageRank(article.sourceName);
    });
    return articles;
}

// update stem-word relationship
async function storeWordStem(articles) {
    let wordStems = new Map(); // (word, stem) -> frequency
    preprocessArticles(articles, (word, stem) => {
        let old = wordStems.get(tuple(word, stem)) || 0;
        wordStems.set(tuple(word, stem), old + 1);
    });
    let entries = []; // [(stem, word, freq)]
    for (let [[word, stem], freq] of wordStems.entries()) {
        entries.push({stem: db.escape(stem), word: db.escape(word), freq});
    }
    await db.insertEntries('WordStem', entries, `ON DUPLICATE KEY UPDATE freq = freq + VALUES(freq)`);
}

// update word-index
async function storeWordIndex(articles) {
    let entries = []; // [(stem, articleId, freq)]
    for (let article of articles) {
        let wordsPerArticle = new Map(); // stem -> freq
        for (let stem of article.tokens) {
            let old = wordsPerArticle.get(stem) || 0;
            wordsPerArticle.set(stem, old + article.pagerank);
        }
        for (let [stem, freq] of wordsPerArticle.entries()) {
            entries.push({stem: db.escape(stem), articleId: article.id, freq})
        }
    }
    await db.insertEntries('WordIndex', entries); // throw error on duplication
}

/** Update WordIndex table & WordStem table incrementally
 * @param idMin{int}
 * @param idMax{int}
 * @return {Promise<void>}
 */
async function updateWordIndex(idMin = 0, idMax = 0) {
    debug('Updating WordIndex/WordStem table...');
    try {
        var oldRows = await db.countTableRows('WordIndex');
        idMin = idMin || (await db.doSql('SELECT MIN(id) AS id FROM Articles'))[0].id;
        idMax = idMax || (await db.doSql('SELECT MAX(id) AS id FROM Articles'))[0].id;
        let bar = new ProgressBar('  [:bar] :rate/bps :percent :etas', {
            complete: '=',
            incomplete: ' ',
            head: '>',
            width: 20,
            total: idMax - idMin + 1,
        });
        // io with database per bulk
        for (let curId = idMin; curId <= idMax; curId += ID_STEP) {
            bar.tick(ID_STEP);
            let articles = await db.doSql(`SELECT * FROM Articles WHERE id BETWEEN ${curId} AND ${curId + ID_STEP - 1}`);
            if (articles.length === 0) continue;
            await storeWordStem(articles);
            console.assert(articles[0].pagerank !== undefined);
            await storeWordIndex(articles);
        }
        var newRows = await db.countTableRows('WordIndex');
    } catch (err) {
        console.error(chalk.red('Error when updating WordIndex:'), err.message);
        throw err;
    }
    debug('Update WordIndex/WordStem success.', chalk.green(`[+] ${newRows - oldRows} records.`), `${newRows} records in total.`);
}


module.exports = {
    preprocessArticles,
    updateWordIndex,
};
