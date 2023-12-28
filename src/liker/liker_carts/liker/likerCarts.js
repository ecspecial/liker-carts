import fs from 'fs';
import os from 'os';
import path from 'path';
import axios from "axios";
import { createCursor } from "ghost-cursor";
import { plugin } from "puppeteer-with-fingerprints";
import { installMouseHelper } from "../helper/install-mouse-helper.js";
import { sendErrorToTelegram } from "../../../../WB_module/telegram/telegramErrorNotifier.js";
import { getFullSessionByPhone } from "../../../../WB_module/session/controller/sessionController.js";
import {
    getCurrentIP,
    getCurrentIPWithPuppeteer,
    checkProxy,
    checkProxyWithPuppeteer
} from "../../../../WB_module/network/controller/networkController.js";

// Функция инициализирует и проверяет начальный IP и работоспособность прокси.
async function initializeAndCheck(proxyString, phoneNumber, id) {
    // console.log('Получаем IP без прокси...');
    const initialIP = await getCurrentIP(axios);
    if (!initialIP) {
        console.error('Не удалось определить начальный IP. Выход...');
        await sendErrorToTelegram(`Не удалось определить начальный IP для номера ${phoneNumber} при добавлении в корзину артикула ${id}, прокси ${proxyString}`, 'initializeAndCheck');
        return false;
    }

    // console.log('Начинаем проверку прокси...');
    const isProxyWorking = await checkProxy(proxyString);
    if (!isProxyWorking) {
        console.error('Прокси не работает. Выход...');
        await sendErrorToTelegram(`Не смогли подключить прокси proxyString для номера  ${phoneNumber} при добавлении в корзину артикула ${id}, прокси ${proxyString}.`, 'checkProxy');
        return false;
    }
    // console.log('Прокси работает');
    // console.log('IP без прокси', initialIP);
    return initialIP;
}

  // Функция инициализирует браузер, устанавливает прокси, открывает страницы.
  async function setupBrowserAndPages(proxyString, fingerprint, cookies, phoneNumber, id) {
    try {
        // console.log('Начинаем настройку браузера...');
        const proxyParts = proxyString.split(':');
        if (proxyParts.length !== 4) {
            throw new Error('Некорректная строка прокси. Прокси должен быть в формате IP:PORT:USER:PASS');
        }

        // console.log('Выставляем прокси и отпечаток...');
        await plugin.useProxy(`${proxyString}`);
        await plugin.useFingerprint(fingerprint, {
            emulateDeviceScaleFactor: false,
            usePerfectCanvas: true,
            safeElementSize: true,
        });

        const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'puppeteer-'));

        // console.log('Запускаем браузер...');
        const browser = await plugin.launch({
            headless: true,
            userDataDir: userDataDir,
        });


        const page = await browser.newPage();
        const pageForIPCheck = await browser.newPage();

        await page.setCookie(...cookies);

        const cursor = await createCursor(page);

        return { browser, page, pageForIPCheck, cursor, userDataDir };

    } catch (error) {
        console.error(`Ошибка при настройке браузера и страниц: ${error.message}`);
        await sendErrorToTelegram(`Ошибка при настройке браузера и страниц для номера ${phoneNumber} при добавлении в корзину артикула ${id}, прокси ${proxyString}: ${error.message}`, 'setupBrowserAndPages');
        return null;
    }
}

// Функция проверки работы прокси внутри puppeteer.
async function checkPuppeteerProxy(pageForIPCheck, initialIP, proxyString, phoneNumber, id) {
    try {
        if (!(await checkProxyWithPuppeteer(pageForIPCheck, initialIP))) {
            console.error('Прокси не работает внутри puppeteer. Выход...');
            await sendErrorToTelegram(`Прокси ${proxyString} не работает внутри puppeteer при добавлении в корзину для номера ${phoneNumber}.`, 'checkPuppeteerProxy');
            return false;
        }
        return true;

    } catch (error) {
        console.error(`Ошибка при проверке прокси в puppeteer: ${error.message}`);
        await sendErrorToTelegram(`Ошибка при проверке прокси ${proxyString} в puppeteer для номера ${phoneNumber} при добавлении в корзину артикула ${id}: ${error.message}`, 'checkPuppeteerProxy');
        return false;
    }
}

// Функция для загрузки страницы с повторными попытками
async function loadPage(page, phoneNumber, id, maxRetries = 3) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            await page.goto('https://www.wildberries.ru/', {
                waitUntil: 'networkidle2',
                timeout: 180000
            });

            await page.waitForSelector('[class*=banner]', { visible: true, timeout: 180000 });
            // console.log('-------> WB открыт (Wildberries открыт)');
            return;
        } catch (error) {
            console.error(`Произошла ошибка при загрузке ВБ (попытка ${attempt + 1}): ${error.message}`);
            if (attempt === maxRetries - 1) {
                await sendErrorToTelegram(`Не удалось загрузить ВБ после ${maxRetries} попыток для номера ${phoneNumber} при добавлении в корзину артикула ${id}.`, 'loadPage');
            }
        }
    }
}

// Функция получения случайной задержки
function getRandomDelay(min, max) {
    return Math.floor(Math.random() * (max - min + 1) + min);
}

// Функция медленного ввода текста
async function typeSlowly(element, text, phoneNumber, id) {
    try {
        for (let char of text) {
            await element.type(char, { delay: getRandomDelay(500, 700) });
        }
    } catch (error) {
        const errorMessage = `Ошибка при медленном вводе текста для номера ${phoneNumber} и артикула ${id}: ${error.message}`;
        console.error(errorMessage);
        await sendErrorToTelegram(errorMessage, 'typeSlowly');
    }
}

// Функция ввода запроса в поисковую строку
async function typeSearch(page, productQuery, phoneNumber, cursor, id, attempt = 0) {
    try {
        // console.log('-------> Начали поиск товара...');

        if (attempt >= 10) {
            throw new Error('Превышено максимальное количество попыток открытия поиска');
        }

        const searchButtonSelector = '.nav-element__search.j-search-header-icon';
        const searchButton = await page.waitForSelector(searchButtonSelector, { visible: true });
        await page.waitForTimeout(10000);
        // await cursor.click(searchButton);
        await moveCursorRandomly(page, cursor, phoneNumber, id);
        await searchButton.click();
        await page.waitForTimeout(15000);
        // console.log('-------> Кликнули на кнопку поиска');

        try {
            await page.waitForSelector('.popup-search__cancel', { visible: true });
            // console.log('-------> Кнопка отмены появилась, продолжаем...');
        } catch {
            console.error('-------> Кнопка отмены не появилась, перезагружаем страницу...');
            await page.reload({ waitUntil: ['networkidle2'] });
            return await typeSearch(page, productQuery, phoneNumber, cursor, id, attempt + 1);
        }

        const searchInputSelector = '#mobileSearchInput';
        const searchInput = await page.waitForSelector(searchInputSelector, { visible: true });
        // const searchInput = await page.waitForSelector('#mobileSearchInput');
        // console.log('-------> Нашли строку поиска');

        // await cursor.click(searchInput);
        await moveCursorRandomly(page, cursor, phoneNumber, id);
        await searchInput.click();
        // console.log('-------> Кликнули на строку поиска');

        await typeSlowly(searchInput, productQuery, phoneNumber, id);
        // console.log('-------> Вставили текстовый запрос');

        await page.keyboard.press('Enter');
        // console.log('-------> Отправили поисковой запрос');

        await page.waitForSelector('.searching-results', { visible: true, timeout: 120000 });
        // console.log('-------> Карточки по запросу загрузились');

    } catch (error) {
        const errorMessage = `Произошла ошибка при выполнении поискового запроса "${productQuery}" для номера ${phoneNumber} при добавлении в корзину артикула ${id}: ${error.message}`;
        console.error(`-------> ${errorMessage}`);
        await sendErrorToTelegram(errorMessage, 'typeSearch');
    }
}

// Функция ввода запроса в поисковую строку
async function typeSearchById(page, productQuery, phoneNumber, cursor, id) {
    try {
        // console.log('-------> Начали поиск товара...');

        if (attempt >= 10) {
            throw new Error('Превышено максимальное количество попыток открытия поиска');
        }

        const searchButtonSelector2 = '.nav-element__search.j-search-header-icon';
        const searchButton2 = await page.waitForSelector(searchButtonSelector2, { visible: true });
        // const searchButton = await page.waitForSelector('.nav-element__search.j-search-header-icon', { visible: true });
        // await cursor.click(searchButton);
        await moveCursorRandomly(page, cursor, phoneNumber, id);
        await searchButton2.click();

        // console.log('-------> Кликнули на кнопку поиска');

        try {
            await page.waitForSelector('.popup-search__cancel', { visible: true, timeout: 30000 });
            // console.log('-------> Кнопка отмены появилась, продолжаем...');
        } catch {
            console.error('-------> Кнопка отмены не появилась, перезагружаем страницу...');
            await page.reload({ waitUntil: ['networkidle2'] });
            return await typeSearch(page, productQuery, phoneNumber, cursor, id, attempt + 1);
        }

        const searchInputSelector2 = '#mobileSearchInput';
        const searchInput2 = await page.waitForSelector(searchInputSelector2, { visible: true });
        // const searchInput = await page.waitForSelector('#mobileSearchInput');
        // console.log('-------> Нашли строку поиска');

        // await cursor.click(searchInput);
        await moveCursorRandomly(page, cursor, phoneNumber, id);
        await searchInput2.click();
        // console.log('-------> Кликнули на строку поиска');

        await typeSlowly(searchInput, productQuery, phoneNumber, id);
        // console.log('-------> Вставили текстовый запрос');

        await page.keyboard.press('Enter');
        // console.log('-------> Отправили поисковой запрос');

        await page.waitForSelector('.details-section__header', { timeout: 120000 });
        await page.waitForXPath("//button[text()='Развернуть характеристики']", { timeout: 120000 });
        // console.log('-------> Карточка товара загружена и отображена');
        return true;

    } catch (error) {
        const errorMessage = `Произошла ошибка при выполнении поискового запроса по артикулу "${productQuery}" для номера ${phoneNumber} при добавлении в корзину артикула ${id}: ${error.message}`;
        console.error(`-------> ${errorMessage}`);
        await sendErrorToTelegram(errorMessage, 'typeSearchById');
    }
}

async function humanScroll(page, scrollAmount, phoneNumber, id) {
    try {
        const scrollSteps = 10;
        const stepAmount = scrollAmount / scrollSteps;

        for (let i = 0; i < scrollSteps; i++) {
            await page.evaluate(step => window.scrollBy(0, step), stepAmount);
            await page.waitForTimeout(getRandomDelay(30, 100));
        }
    } catch (error) {
        const errorMessage = `Ошибка при медленном скроллинге для номера ${phoneNumber} и артикула ${id}: ${error.message}`;
        console.error(errorMessage);
        await sendErrorToTelegram(errorMessage, 'humanScroll');
    }
}

// Функция получения размеров браузера
async function getViewportSize(page, phoneNumber, id) {
    try {
        return await page.evaluate(() => ({
            width: document.documentElement.clientWidth,
            height: document.documentElement.clientHeight
        }));
    } catch (error) {
        const errorMessage = `Ошибка при получении размеров окна браузера для номера ${phoneNumber} и артикула ${id}: ${error.message}`;
        console.error(errorMessage);
        await sendErrorToTelegram(errorMessage, 'getViewportSize');
    }
}

// Функция случайного перемещеня курсора
async function moveCursorRandomly(page, cursor, phoneNumber, id) {
    try {
        const viewport = await getViewportSize(page, phoneNumber, id);
        const randomX = Math.random() * viewport.width;
        const randomY = Math.random() * viewport.height;
        await cursor.moveTo({ x: randomX, y: randomY });
    } catch (error) {
        const errorMessage = `Ошибка при случайном перемещении курсора для номера ${phoneNumber} и артикула ${id}: ${error.message}`;
        console.error(errorMessage);
        await sendErrorToTelegram(errorMessage, 'moveCursorRandomly');
    }
}

// Функция поиска элемента на странице по аттрибуту
async function findElementByAttribute(page, attributeName, value, phoneNumber) {
    try {
        return await page.$(`[${attributeName}="${value}"]`);
    } catch (error) {
        const errorMessage = `Ошибка при поиске элемента на странице по атрибуту ${attributeName} для номера ${phoneNumber} и артикула ${value}: ${error.message}`;
        console.error(errorMessage);
        await sendErrorToTelegram(errorMessage, 'findElementByAttribute');
    }
}

// Функция переключения страницы
async function clickNextPageIfPresent(page, phoneNumber, id) {
    try {
        const nextPageButton = await page.$('a.pagination-next.pagination__next.j-next-page');

        if (nextPageButton) {
            const navigationPromise = page.waitForNavigation();
            await nextPageButton.click();
            await navigationPromise;
            await page.waitForTimeout(5000);
            return true; // Следующая страница найдена
        } else {
            console.log('-------> Нет следующей страницы, завершаем поиск');
            return false; // Следующая страница не найдена
        }
    } catch (error) {
        const errorMessage = `Ошибка при переключении на следующую страницу для номера ${phoneNumber} и артикула ${id}: ${error.message}`;
        console.error(errorMessage);
        await sendErrorToTelegram(errorMessage, 'clickNextPageIfPresent');
        return false; // Произошла ошибка при переключении страницы
    }
}

// Функция скролла и поиска необходимого элемента
async function scrollAndFind(page, cursor, id, phoneNumber) {
    // console.log('-------> Скроллим страницу вниз');
    let pageNumber = 1;
    const maxPageNumber = 50;

    try {
        let previousScrollHeight = 0;
        let consecutiveNoHeightChange = 0;

        while (pageNumber <= maxPageNumber) {
            let currentScrollHeight = await page.evaluate(() => document.body.scrollHeight);
            await humanScroll(page, 800 + Math.floor(Math.random() * 51), phoneNumber, id);
            await page.waitForTimeout(getRandomDelay(1500, 2500));
            await moveCursorRandomly(page, cursor, phoneNumber, id);

            const atBottom = await page.evaluate(() => window.innerHeight + window.scrollY >= document.body.scrollHeight);
            const foundElement = await findElementByAttribute(page, "data-nm-id", id, phoneNumber);

            if (foundElement) {
                // console.log(`-------> Найден товар с артикулом ${id}`);
                return foundElement;
            }

            if (currentScrollHeight === previousScrollHeight) {
                consecutiveNoHeightChange++;
            } else {
                consecutiveNoHeightChange = 0;
            }

            if (atBottom || consecutiveNoHeightChange >= 3) {
                if (!(await clickNextPageIfPresent(page, phoneNumber, id))) {
                    // console.log(`-------> Максимальная страница достигнута или нет следующей страницы на странице ${pageNumber}`);
                    return false;
                }
                pageNumber++;
            }

            previousScrollHeight = currentScrollHeight;
        }
        console.log('-------> Достигнуто максимальное количество страниц');
        return false;
    } catch (error) {
        const errorMessage = `Необработанная ошибка при скролле и поиске для номера ${phoneNumber} и артикула ${id}: ${error.message}`;
        console.error(errorMessage);
        await sendErrorToTelegram(errorMessage, 'scrollAndFind');
        return null; // В случае ошибки возвращаем null
    }
}

// Функция открытия карточки товара
async function openElement(page, element, phoneNumber, id) {
    let detailsLoaded = false;
    let attempts = 0;
    const maxAttempts = 5;

    while (!detailsLoaded && attempts < maxAttempts) {
        try {
            await element.click();
            // console.log('-------> Попытка открыть карточку товара');

            await page.waitForSelector('.details-section__header', { timeout: 120000 });
            // await page.waitForXPath("//button[text()='Развернуть характеристики']", { timeout: 120000 });
            // console.log('-------> Карточка товара загружена и отображена');
            detailsLoaded = true;
        } catch (error) {
            console.error(`Ошибка при попытке открыть карточку товара (попытка ${attempts + 1}): ${error.message}`);
            await page.waitForTimeout(3000);
            attempts++;
        }
    }

    if (!detailsLoaded) {
        throw new Error(`Не удалось открыть карточку товара после ${maxAttempts} попыток`);
    }
}

// Функция добавления товара в корзину на странице товара
async function navigateToCartAndVerifyProduct(page, cursor, size, id, phoneNumber) {
    try {
        const maxCartAttempts = 3;
        let cartAttempts = 0;
        const currentUrl = page.url();

        while (cartAttempts < maxCartAttempts) {
            // Выбор размера при наличии параметра
            await page.waitForTimeout(3000);
            if (size !== 'none') {
                let sizeSelected = false;
                let attempts = 0;
                const maxAttempts = 5;

                while (!sizeSelected && attempts < maxAttempts) {
                    const sizeButtonXPath = `//ul[@class='sizes-list']/li/label/span[contains(text(), '${size}')]/ancestor::label`;
                    const [sizeButton] = await page.$x(sizeButtonXPath);

                    if (sizeButton) {
                        await page.evaluate((el) => {
                            const elementRect = el.getBoundingClientRect();
                            const absoluteElementTop = elementRect.top + window.pageYOffset;
                            const middle = absoluteElementTop - (window.innerHeight / 2);
                            window.scrollTo(0, middle);
                        }, sizeButton);

                        await page.waitForTimeout(3000);

                        await sizeButton.click();
                        // await cursor.click(sizeButton);
                        await moveCursorRandomly(page, cursor, phoneNumber, id);
                        // console.log('-------> Выбран размер:', size);

                        await page.waitForTimeout(3000);
                        sizeSelected = await page.evaluate((el) => {
                            return el.classList.contains('active');
                        }, sizeButton);

                        if (!sizeSelected) {
                            // console.log('-------> Размер не выбран, пытаемся снова...');
                            await page.waitForTimeout(3000);
                        }
                    } else {
                        throw new Error(`Размер ${size} не найден`);
                    }
                    attempts++;
                }

                if (!sizeSelected) {
                    throw new Error(`Не удалось выбрать размер ${size}`);
                }
            }

            const [addToCartButton] = await page.$x("//button[contains(., 'Добавить в корзину') or contains(., 'В корзину')]", { visible: true, timeout: 60000 });
            if (addToCartButton) {
                await addToCartButton.click();
                // await cursor.click(addToCartButton);
                await moveCursorRandomly(page, cursor, phoneNumber, id);
                await page.waitForTimeout(15000);
                // console.log('-------> Кнопка добавления в корзину нажата.');
                const [goToCartButton] = await page.$x("//a[contains(., 'Перейти в корзину')]", { visible: true, timeout: 60000 });
                if (goToCartButton) {
                    await moveCursorRandomly(page, cursor, phoneNumber, id);
                    await goToCartButton.click();
                    // await cursor.click(goToCartButton);
                    await page.waitForTimeout(30000);
                    await page.waitForSelector('.basket-section__header.active', { timeout: 120000 });
                    const productAdded = await page.$eval('a.good-info__title.j-product-popup', (elem, productId) => elem.href.includes(productId), id);
                    if (productAdded) {
                        // console.log('-------> Товар успешно добавлен в корзину.');
                        return true;
                    }
                    else {
                        console.error('-------> Товар не добавлен в корзину.');
                    }
                } else {
                    const errorMessage = '-------> Кнопка Перейти в корзину не найдена.';
                    console.error(errorMessage);
                }
            } else {
                const errorMessage = '-------> Кнопка добавления в корзину не найдена.';
                console.error(errorMessage);
            }
            await page.goto(currentUrl, { waitUntil: ['networkidle2'] });
            cartAttempts++;
        }
    } catch (error) {
        const errorMessage = `-------> Произошла ошибка при взаимодействии с карточкой товара для номера ${phoneNumber} и артикула ${id}: ${error.message}`;
        console.error(errorMessage);
        await sendErrorToTelegram(`Произошла ошибка при взаимодействии с карточкой товара для номера ${phoneNumber} и артикула ${id}.`, 'addToCartOnPage');
        return false;
    }
}

// Функция добавления товара в корзину
async function addToCartOnPage(page, cursor, size, id, phoneNumber) {
    try {

      const productSuccessfullyAdded = await navigateToCartAndVerifyProduct(page, cursor, size, id, phoneNumber);

      if (!productSuccessfullyAdded) {
          const errorMessage = `-------> Товар не был добавлен в корзину для номера ${phoneNumber} и артикула ${id}.`;
          console.error(errorMessage);
          await sendErrorToTelegram(errorMessage, 'addToCartOnPage');
      }

    } catch (error) {
        const errorMessage = `-------> Произошла ошибка при взаимодействии с карточкой товара для номера ${phoneNumber} и артикула ${id}: ${error.message}`;
        console.error(errorMessage);
        await sendErrorToTelegram(`Произошла ошибка при взаимодействии с карточкой товара для номера ${phoneNumber} и артикула ${id}.`, 'addToCartOnPage');
    }
  }

  async function deleteItemsFromBasket(page, cursor) {
    try {
        await page.waitForSelector('.accordion__list');

        const deleteButtons = await page.$$('.accordion__list .j-basket-item-del');
        for (let btn of deleteButtons) {
            await btn.click();
            // await cursor.click(btn);
            await page.waitForTimeout(3000);
        }

        // console.log('-------> Удалили товары из корзины');

    } catch (error) {
        console.error("Ошибка при удалении товаров в корзине:", error.message);
    }
}

// Функция добавления товара в корзину
async function checkCartAmountBeforeAdd(page, cursor, phoneNumber, id) {
    try {
        await page.goto('https://www.wildberries.ru/lk/basket', {
            waitUntil: 'networkidle2',
            timeout: 320000
        });

        await page.waitForSelector('h1.section-header.basket-empty__title, h1.basket-section__header.active', { visible: true, timeout: 120000 });

        const isEmptyBasketHeader = await page.$('h1.section-header.basket-empty__title');
        if (isEmptyBasketHeader) {
            // console.log('-------> Корзина пуста');
            return;
        }

        const isHeaderActive = await page.$('h1.basket-section__header.active');
        if (!isHeaderActive) {
            throw new Error("Header 'h1.basket-section__header.active' not found");
        }

        // console.log('-------> WB корзина открыта');

        // Получаем количество товаров в корзине
        const dataCountValue = await page.$eval('h1.basket-section__header.active', header => header.getAttribute('data-count'));
        // console.log('-------> data-count:', dataCountValue);

        const count = parseInt(dataCountValue);
        if (count >= 10) {
            console.log('-------> Количество товаров в корзине превышает 10, удаляем...');
            await deleteItemsFromBasket(page, cursor);
        }

    } catch (error) {
        const errorMessage = `Произошла ошибка при открытии ВБ для проверки корзины номера ${phoneNumber} при добавлении в корзину артикула ${id}: ${error.message}`;
        console.error(errorMessage);
        await sendErrorToTelegram(errorMessage, 'checkCartAmountBeforeAdd');
    }
}


// Функция проверки работы прокси внутри puppeteer с повторными попытками.
async function checkPuppeteerProxyWithRetries(pageForIPCheck, initialIP, proxyString, phoneNumber, retries = 3) {
    let attempt = 0;
    while (attempt < retries) {
        try {
            if (await checkProxyWithPuppeteer(pageForIPCheck, initialIP)) {
                return true;
            }
        } catch (error) {
            console.error(`Ошибка при проверке прокси в puppeteer (попытка ${attempt + 1}): ${error.message}`);
        }
        await new Promise(resolve => setTimeout(resolve, 30000));
        attempt++;
    }
    await sendErrorToTelegram(`Прокси ${proxyString} не работает в puppeteer после ${retries} попыток при добавлении в корзину для номера ${phoneNumber}.`, 'checkPuppeteerProxyWithRetries');
    return false;
}


// Функция поиска элемента по артикулу
async function findItemByArticle(page, id, phoneNumber, cursor) {
    try {
        await page.goto('https://www.wildberries.ru/', {
            waitUntil: 'networkidle2',
            timeout: 320000
        });

        await page.waitForSelector('[class*=banner]', { visible: true, timeout: 180000 });
        // console.log('-------> WB открыт (Wildberries открыт)');

        const openedPageByArticle = await typeSearchById(page, id, phoneNumber, cursor, id);

        if (openedPageByArticle) {
            // console.log(`Нашли и открыли товар по артикулу: ${id}`);
            return openedPageByArticle;
        } else {
            console.log(`Не нашли и не открыли товар по артикулу: ${id}.`);
            return null;
        }
    } catch (error) {
        console.error(`Ошибка при открытии товара по артикулу ${id} для номера ${phoneNumber}: ${error.message}`);
        await sendErrorToTelegram(`Ошибка при открытии товара по артикулу ${id} для номера ${phoneNumber}: ${error.message}`, 'findItemByArticle');
        return null;
    }
}

// Главная функция по загрузке браузера, проверке прокси и добавлению товара в корзину
export async function addToCart(phoneNumber, proxyString, productArticle, productQuery, size) {
    let checkInterval;
    let browser;
    let userDataDir; 

    try {
        const initialIP = await initializeAndCheck(proxyString, phoneNumber, productArticle);
        if (!initialIP) {
            return 'NO_AVAILABLE_PROXY';
        }

        const { cookies, fingerprint } = await getFullSessionByPhone(phoneNumber);
        // console.log(fingerprint, cookies)
        // fingerprint = JSON.stringify(finger);
        // console.log(fingerprint);

        // console.log(cookies);
        const setupResult = await setupBrowserAndPages(proxyString, fingerprint, cookies, phoneNumber, productArticle);
        browser = setupResult.browser;
        userDataDir = setupResult.userDataDir;

        // Проверяем, подключен ли прокси
        if (!(await checkPuppeteerProxy(setupResult.pageForIPCheck, initialIP, proxyString, phoneNumber, productArticle))) return;

        // Периодически проверяем прокси
        checkInterval = setInterval(async () => {
            if (!(await checkPuppeteerProxyWithRetries(setupResult.pageForIPCheck, initialIP, proxyString, phoneNumber))) {
                console.error(`Потеряли связь с прокси . Выход...`);
                clearInterval(checkInterval);
                if (browser) {
                    await browser.close();
                }
                return;
            }
        }, 2 * 60 * 1000);

        // console.log('Выводим страницу для взаимодействия...');
        setupResult.page.bringToFront();
        // console.log('Устанавливаем  MouseHelper...');
        await installMouseHelper(setupResult.page);

        // console.log('Загружаем ВБ...');
        await loadPage(setupResult.page, phoneNumber, productArticle);

        // console.log('Переходим в корзину  ВБ...');

        await checkCartAmountBeforeAdd(setupResult.page, setupResult.cursor, phoneNumber, productArticle);

        // console.log('Загружаем ВБ...');
        await loadPage(setupResult.page, phoneNumber, productArticle);

        const searchAttempts = 2;
        let searchSuccess = false;

        for (let i = 0; i < searchAttempts; i++) {
            try {
                await typeSearch(setupResult.page, productQuery, phoneNumber, setupResult.cursor, productArticle);
                searchSuccess = true;
                break;
            } catch (error) {
                console.error(`Ошибка при попытке поиска (попытка ${i + 1}): ${error.message}`);
                if (i < searchAttempts - 1) {
                    console.log(`Перезагружаем страницу и пытаемся снова...`);
                    await loadPage(setupResult.page, phoneNumber, productArticle);
                } else {
                    await sendErrorToTelegram(`Ошибка при попытке поиска после нескольких попыток для номера ${phoneNumber} и артикула ${id}: ${error.message}`, 'typeSearch');
                }
            }
        }

        if (!searchSuccess) {
            console.log('Поиск не удался после нескольких попыток');
            await browser.close();
            return 'PRODUCT_NOT_FOUND';
        }

        const foundProduct = await scrollAndFind(setupResult.page, setupResult.cursor, productArticle, phoneNumber);

        if (foundProduct) {
            // console.log('Нашли нужный товар');
            await openElement(setupResult.page, foundProduct);
            // await elementInteract(setupResult.page, setupResult.cursor, phoneNumber, productArticle);
            await addToCartOnPage(setupResult.page, setupResult.cursor, size, productArticle, phoneNumber);
            return 'SUCCESS';
        } else {
            console.log('Товар не найден при скроллинге, пытаемся найти по артикулу...');
            const foundByArticle = await findItemByArticle(setupResult.page, productArticle, phoneNumber, setupResult.cursor);
            if (foundByArticle) {
                // console.log('Нашли нужный товар по артикулу');
                // await elementInteract(setupResult.page, setupResult.cursor, phoneNumber, productArticle);
                await addToCartOnPage(setupResult.page, setupResult.cursor, size, productArticle, phoneNumber);
                return 'SUCCESS';
            } else {
                console.log('Товар по артикулу не найден');
                return 'PRODUCT_NOT_FOUND';
            }
        }

    } catch (error) {
        console.error(`-------> Произошла ошибка: ${error.message}`);
        await sendErrorToTelegram(`Ошибка при добавлении в корзину для номера ${phoneNumber} и артикула ${productArticle}: ${error.message}`, 'MainCartLogic');
        return 'ERROR';
    } finally {
        if (checkInterval) {
            clearInterval(checkInterval); // Очистка интервала проверки прокси
        }

        await new Promise(resolve => setTimeout(resolve, 11000));

        if (browser) {
            await browser.close();
        }

        if (userDataDir) {
            fs.rm(userDataDir, { recursive: true, force: true }, (err) => {
                if (err) {
                    console.error(`Ошибка при удалении временной директории: ${err.message}`);
                }
            });
        }
      }
  }

// const cartItem = {
//     _id: "648d49e4a8cee8faf464d778",
//     user: "650421503a208665e16f2007",
//     status: 'created',
//     query: 'штаны карго камуфляж',
//     article: '88712750',
//     amount: 90,
//     period: '1hour',
//     name: 'Secrets Lan Прокладки ночные Целебные травы',
//     image: 'https://basket-05.wb.ru/vol954/part95462/95462001/images/big/1.jpg',
//     size: '48-50/170-176',
//     createdDate: "2023-06-16T16:34:58.455Z",
//     __v: 0,
//     endedDate: "2023-07-06T09:51:40.806Z"
//   }

//   await addToCart('79062606989', '188.143.169.28:30159:iparchitect_629_31_08_23:nNFiaQ5nBbzBnyyrhr', cartItem.article, cartItem.query, cartItem.size);