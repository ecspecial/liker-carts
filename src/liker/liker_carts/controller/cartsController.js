import axios from 'axios';
import { ObjectId } from 'mongodb';
import { addToCart } from '../liker/likerCarts.js';
import { sendErrorToTelegram } from '../../../../WB_module/telegram/telegramErrorNotifier.js';

// Функция-обёртка для повторного выполнения функций
async function executeWithRetry(action, ...params) {
    const maxRetries = 1;
    // const delay = 60000;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await action(...params);
        } catch (error) {
            if (attempt < maxRetries) {
                console.warn(`Ошибка в ${action.name}. Попытка ${attempt} из ${maxRetries}. Повтор через ${delay/1000} секунд...`, error);
                // await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                console.error(`Достигнуто максимальное количество попыток для ${action.name}. Завершаем...`, error);
                await sendErrorToTelegram(`Ошибка после ${maxRetries} попыток в ${action.name} для номера ${params[0]}.`, action.name);
                return 'ERROR_MAX_RETRIES';
            }
        }
    }
    return 'ERROR';
}

export async function addToCartHandler(phoneNumber, proxyString, productArticle, productQuery, size) {
    try {
        const outcome = await executeWithRetry(addToCart, phoneNumber, proxyString, productArticle, productQuery, size);

        if (outcome === 'PRODUCT_NOT_FOUND') {
            console.warn(`Продукт не найден для аккаунта: ${phoneNumber}`);
        }

        if (outcome === 'NO_AVAILABLE_PROXY') {
            console.warn(`Прокси не работает.`);
        }
        
        return outcome;
    } catch (error) {
        console.error('Ошибка в addToCartHandler:', error);
        await sendErrorToTelegram(error.message, 'addToCartHandler');
        return 'ERROR';
    }
}