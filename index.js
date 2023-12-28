import axios from 'axios';
import cors from 'cors';
import chalk from 'chalk';
import async from 'async';
import dotenv from 'dotenv';
import express from 'express';
import { ObjectId } from 'mongodb';
import { getIPAddress } from './WB_module/network/utility/ip.js';
import { checkProxy } from './WB_module/network/controller/networkController.js';
import { getCurrentDateInMoscow } from './WB_module/queue/utility/time.js';
import { sendErrorToTelegram } from './WB_module/telegram/telegramErrorNotifier.js';
import { addToCartHandler } from './src/liker/liker_carts/controller/cartsController.js';
import { 
    getProxyWithRetries, 
    getRandomMobileAccountWithRetries,
    getRandomPhoneNumberWithRetries
} from './WB_module/queue/utility/resourses.js';
import { 
    checkNewCartLikes, 
    processWorkRecords, 
    rescheduleIncompleteTasks, 
    updateNoFundsRecordsWithBalances 
} from './src/liker/controller_carts/cartsDbController.js';
import { 
    databaseConnectRequest, 
    getDb, 
    database2ConnectRequest, 
    getDb2, 
    database3ConnectRequest, 
    getDb3
} from './WB_module/database/config/database.js';

// Подключение env файла
dotenv.config();

// Настройка сервера express + использование cors и json
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4002;

// Стоимость добавления в корзину
const PRICE_PER_CART_LIKE = 5;

// Настройка максимально допустиых значений параллельного запуска функций
const MAX_TOTAL_ACTIVE_TASKS = 4;
const MAX_PARALLEL_CARTS = 4;

const MINIMUM_INTERVAL_CARTS = 900000;

// Настройка максимально допустимых значений повторного добавления в очередь
const RETRY_LIMIT = 3;
const READD_RETRY_LIMIT = 10;

// Настройка максимально допустимых значений повторного получения прокси
const PROXY_RETRY_LIMIT = 10;

// Настройка параметра возможности добавления новых задач в очередь
let acceptingTasks = true;

// Текущие активные задачи
let totalActiveTasks = 0;
let cartsCount = {
    carts: 0,
};

// Интервалы проверки базы данных
const INTERVAL_NEW_CARTS = 20000;
const INTERVAL_WORK_CARTS = 25000;
const INTERVAL_INCOMPLITE_CARTS = 30000;
const INTERVAL_NOFUNDS_CARTS = 35000;

// Метод получения базового ответа от API cartsliker
app.get('/api/', (req, res) => {
    res.status(200).json('Привет от API cartsliker!');
});

// Метод остановки принятия задач в очередь API cartsliker
app.post('/api/stopQueue', async (req, res) => {
    acceptingTasks = false;
    res.status(200).json({ message: 'Остановили принятие задач на обработку в очередь' });
});

// Метод запуска принятия задач в очередь API cartsliker
app.post('/api/startQueue', async (req, res) => {
    acceptingTasks = true;
    res.status(200).json({ message: 'Возобновили принятие задач на обработку в очередь' });
});

// Метод запуска принятия задач в очередь API cartsliker
app.post('/api/resetQueueCount', async (req, res) => {
    totalActiveTasks = 0;
    cartsCount['carts'] = 0;
    res.status(200).json({ message: 'Сбросили очередь.' });
});

// Метод получения статуса очереди API cartsliker
app.get('/api/queueStatus', async (req, res) => {
    try {
        const queueInfo = await getQueueInfo(cartsQueue, acceptingTasks, totalActiveTasks, cartsCount);
        res.status(200).json({
            message: 'Текущее состояние очереди',
            queueInfo: queueInfo
        });
    } catch (error) {
        console.error('Ошибка получения статуса очереди:', error);
        res.status(500).json({ error: 'Ошибка получения статуса очереди' });
    }
});

const startServer = async () => {
    try {
        console.log('Попытка подключения к базе данных...');
        const isConnected = await databaseConnectRequest();
        if (!isConnected) {
            throw new Error('Подключение к базе данных topvtop_backend не может быть установлено');
        }

        const isConnected2 = await database2ConnectRequest();
        if (!isConnected2) {
            throw new Error('Подключение к базе данных payments не может быть установлено');
        }

        const isConnected3 = await database3ConnectRequest();
        if (!isConnected3) {
            throw new Error('Подключение к базе данных topvtop_bd не может быть установлено');
        }

        console.log(chalk.grey('Запускаем сервер...'));
        app.listen(PORT, async () => {
            console.log(chalk.green(`Сервер запущен на порту ${PORT}`));

            setInterval(async () => {
                try {
                    if (acceptingTasks) {
                        await checkNewCartLikes();
                    }
                } catch (error) {
                    console.error('Ошибка при проверке новых добавлений в корзину:', error);
                    await sendErrorToTelegram(`Ошибка при проверке новых добавлений в корзину: ${error.message}`, 'checkNewCartLikes');
                }
            }, INTERVAL_NEW_CARTS);

            setInterval(async () => {
                try {
                    if (acceptingTasks) {
                        let eligibleRecords = await processWorkRecords(cartsCount['carts'], acceptingTasks);
                        // console.log('Записи готовые к обработке в статусе "work":', eligibleRecords);
                        await addEligibleRecordsToQueue(eligibleRecords);
                    }
                } catch (error) {
                    console.error('Ошибка при проверке записей в статусе "work":', error);
                    await sendErrorToTelegram(`Ошибка при проверке записей в статусе "work": ${error.message}`, 'processWorkRecords');
                }
            }, INTERVAL_WORK_CARTS);

            setInterval(async () => {
                try {
                    if (acceptingTasks) {
                        await rescheduleIncompleteTasks();
                    }
                } catch (error) {
                    console.error('Ошибка при проверке неполных записей:', error);
                    await sendErrorToTelegram(`Ошибка при проверке неполных записей: ${error.message}`, 'rescheduleIncompleteTasks');
                }
            }, INTERVAL_INCOMPLITE_CARTS);

            setInterval(async () => {
                try {
                    if (acceptingTasks) {
                        await updateNoFundsRecordsWithBalances();
                    }
                } catch (error) {
                    console.error('Ошибка при проверке записей без баланса:', error);
                    await sendErrorToTelegram(`Ошибка при проверке записей без баланса: ${error.message}`, 'updateNoFundsRecordsWithBalances');
                }
            }, INTERVAL_NOFUNDS_CARTS);
        });


    } catch (error) {
        console.error(chalk.red('Ошибка при запуске сервера:', error));
        await sendErrorToTelegram(`Ошибка при запуске сервера: ${error.message}`, 'startServer');
    }
};

startServer().then(server => {
    if (server) {
        server.on('error', (error) => {
            if (error.code === 'EADDRINUSE') {
                console.error(chalk.red(`Порт ${PORT} занят!`));
            } else {
                console.error(chalk.red('Произошла ошибка при запуске сервера:'), error);
            }
        });
    }
});

// Логика воркера очереди задач
const cartsQueue = async.queue(async (task) => {
    try {
        switch (task.cartsRecord.type) {
            case 'carts':
                // console.log('Обработка очереди carts');
                await processCartLike(task);
                break;
            case 'brand':
            case 'product':    
            case 'likes':
                throw new Error(`Данный сервер предназначен для обработки задач из коллекции carts, получили: ${task.cartsRecord.type}`);
            default:
                throw new Error(`Неизвестный тип лайка: ${task.cartsRecord.type}`);
        }
    } catch (error) {
        console.error(`Ошибка при обработке likeId ${task.cartsRecord._id.toString()}:`, error);
        await sendErrorToTelegram(`Ошибка при обработке likeId ${task.cartsRecord._id.toString()}: ${error.message}`, 'processCartsQueue');

        if (error.message === 'NO_AVAILABLE_PROXY' || error.message === 'NO_AVAILABLE_ACCOUNT') {
            await reAddToCartsQueueWithTimeout(task.cartsRecord, task.retries);
        } else {
            throw error;
        }
    }
}, MAX_TOTAL_ACTIVE_TASKS);

cartsQueue.error((err, task) => {
    console.error('Ошибка при обработке задачи:', err, 'Задача:', task);
});

// Функция добавления задач в очередь
const addEligibleRecordsToQueue = async (eligibleRecords) => {
    for (const record of eligibleRecords) {
        if (totalActiveTasks < MAX_TOTAL_ACTIVE_TASKS) {
            const db = getDb();
            await db.collection('carts').updateOne({ _id: record._id }, { $pull: { schedule: new Date(record.schedule[0]) } });
            cartsQueue.push({ cartsRecord: record, retries: 0 });
            await totalActiveTasks++;
            await cartsCount['carts']++;
        }
    }
};

// Функция задержки
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Функция получения информации об очереди
const getQueueInfo = async () => {
    return {
        length: cartsQueue.length(),
        isProcessing: !cartsQueue.idle(),
        acceptingTasks: acceptingTasks,
        totalActiveTasks: totalActiveTasks,
        typesCount: cartsCount,
    };
};

// Функция отслеживания очереди задач
// const processCartsQueue = async () => {
//     console.log("Начало обработки очереди корзины");
//     console.log("Очередь: ", cartsQueue.length());

//     if (cartsQueue.idle()) {
//         console.log("Очередь корзины пуста");
//     } else {
//         console.log("Очередь обрабатывает задачи");
//     }
// }

// Функция добавления cartsRecord в очередь с начальным количеством попыток
async function reAddToCartsQueueWithTimeout(cartsRecord, retries) {
    const db3 = getDb3();
    const idString = cartsRecord._id.toString();
    if (retries < PROXY_RETRY_LIMIT) {
        await delay(180000);
        cartsQueue.unshift({ cartsRecord, retries: retries + 1 });
        console.log(`likeId ${cartsRecord._id} добавлен обратно в очередь после задержки.`);
    } else {
        await totalActiveTasks--;
        await cartsCount['carts']--;
        console.error(`Максимальное количество попыток для добавления в корзину likeId ${cartsRecord._id} достигнуто.`);

        try {
            const record = await db3.collection('carts').findOne({ _id: new ObjectId(idString) });
            let newDate;
            if (record.schedule && record.schedule.length > 0) {
                const lastDate = new Date(record.schedule[record.schedule.length - 1]);
                newDate = new Date(lastDate.getTime() + MINIMUM_INTERVAL_CARTS);
            } else {
                newDate = await getCurrentDateInMoscow();
            }

            await db3.collection('carts').updateOne(
                { _id: new ObjectId(idString) },
                { $push: { schedule: newDate } }
            );
        } catch (error) {
            console.error(`Ошибка при обновлении расписания для likeId ${idString}:`, error);
            await sendErrorToTelegram(`Ошибка при обновлении расписания для likeId ${idString}: ${error.message}`, 'reAddToLikeQueueNoAdd');
        }
    }
}

// Функция для повторного добавления cartsRecord в очередь с обновленным количеством попыток
async function reAddToCartsQueue(cartsRecord, retries) {
    const db3 = getDb3();
    const idString = cartsRecord._id.toString();
    if (retries < RETRY_LIMIT) {
        cartsQueue.unshift({ cartsRecord, retries: retries + 1 });
    } else {
        await totalActiveTasks--;
        await cartsCount['carts']--;
        console.error(`Максимальное количество попыток для добавления в корзину likeId ${cartsRecord._id} достигнуто.`);

        try {
            const record = await db3.collection('carts').findOne({ _id: new ObjectId(idString) });
            let newDate;
            if (record.schedule && record.schedule.length > 0) {
                const lastDate = new Date(record.schedule[record.schedule.length - 1]);
                newDate = new Date(lastDate.getTime() + MINIMUM_INTERVAL_CARTS);
            } else {
                newDate = await getCurrentDateInMoscow();
            }

            await db3.collection('carts').updateOne(
                { _id: new ObjectId(idString) },
                { $push: { schedule: newDate } }
            );
        } catch (error) {
            console.error(`Ошибка при обновлении расписания для likeId ${idString}:`, error);
            await sendErrorToTelegram(`Ошибка при обновлении расписания для likeId ${idString}: ${error.message}`, 'reAddToLikeQueueNoAdd');
        }
    }
}

// Функция для повторного добавления cartsRecord в очередь без обновления количества попыток
async function reAddToCartsQueueNoAdd(cartsRecord, retries) {
    const db3 = getDb3();
    const idString = cartsRecord._id.toString();
    if (retries < READD_RETRY_LIMIT) {
        cartsQueue.unshift({ cartsRecord, retries: retries + 1 });
    } else {
        await totalActiveTasks--;
        await cartsCount['carts']--;
        console.error(`Максимальное количество попыток для добавления в корзину likeId ${cartsRecord._id} достигнуто.`);

        try {
            const record = await db3.collection('carts').findOne({ _id: new ObjectId(idString) });
            let newDate;
            if (record.schedule && record.schedule.length > 0) {
                const lastDate = new Date(record.schedule[record.schedule.length - 1]);
                newDate = new Date(lastDate.getTime() + MINIMUM_INTERVAL_CARTS);
            } else {
                newDate = await getCurrentDateInMoscow();
            }

            await db3.collection('carts').updateOne(
                { _id: new ObjectId(idString) },
                { $push: { schedule: newDate } }
            );
        } catch (error) {
            console.error(`Ошибка при обновлении расписания для likeId ${idString}:`, error);
            await sendErrorToTelegram(`Ошибка при обновлении расписания для likeId ${idString}: ${error.message}`, 'reAddToLikeQueueNoAdd');
        }
    }
}

// Функция уменьшения очереди определенного типа лайков
const decrementLikeCount = async (type) => {
    // Проверяем, что тип добавления в корзину существует в массиве и больше нуля
    if (cartsCount[type] !== undefined && cartsCount[type] > 0) {
        cartsCount[type]--;
        return cartsCount;
    } else {
        console.warn(`Попытка умеьшить cartsCount[${type}] невозможна, значение уже 0.`);
        return false;
    }
}

// Функция обработки добавления в корзину
async function processCartLike(task) {
    const cartsRecord = task.cartsRecord;
    const db = await getDb();
    const db2 = await getDb2();
    const db3 = await getDb3();
    const idString = cartsRecord._id.toString();

    try {
        console.log('Обработка', idString);
        const like = await db3.collection('carts').findOne({ _id: new ObjectId(idString) });

        if (!like) {
            console.error(`Не найдена запись для likeId ${idString} в базе данных.`);

            await totalActiveTasks--;
            await cartsCount['carts']--;

            return;
        }

        const user = await db3.collection('users').findOne({ _id: like.user });
        if (!user) {
            console.error(`Не найден user для likeId ${idString} в базе данных.`);

            await totalActiveTasks--;
            await cartsCount['carts']--;

            return;
        }

        // console.log('Запись успешно получена из базы.');

        const costForAllActions = (like.amount - like.totalAmountMade) * PRICE_PER_CART_LIKE;
        // console.log('costForAllActions', costForAllActions);
        const hasSufficientBalance = user.balance >= costForAllActions;
        // console.log('user.balance', user.balance);
        // console.log('hasSufficientBalance', hasSufficientBalance);

        if (!hasSufficientBalance) {
            console.error(`У юзера с ID ${like.user.toString()} не достаточно средств на балансе для выполнения действий.`);
            await sendErrorToTelegram(`У юзера с ID ${like.user.toString()} не достаточно средств на балансе для выполнения действий.`, 'processCartLike');

            await db3.collection('carts').updateOne(
                { _id: new ObjectId(idString) },
                { $set: { status: 'nofunds' } }
            );

            await totalActiveTasks--;
            await cartsCount['carts']--;

            return;
        }

        let remainingActions = like.amount - like.totalAmountMade;
        // console.log('Оставшиеся действия по добавлению в корзину:', remainingActions);

        if (remainingActions <= 0) {
            if (like.endedDate === null || like.status === 'work') {
                const updateResult = await db3.collection('carts').updateOne(
                    { _id: new ObjectId(idString) },
                    {
                        $set: { 
                            status: 'completed',
                            endedDate: await getCurrentDateInMoscow()
                        }
                    }
                );
    
                if (updateResult.modifiedCount !== 1) {
                    console.warn(`Не удалось установить статус 'completed' для likeId ${idString}`);
                } else {
                    console.log(`Задача на добавление в корзину с likeId ${idString} завершена.`);
                }
            }

            await totalActiveTasks--;
            await cartsCount['carts']--;

            console.warn(`Задача с likeId ${idString} уже получила все необходимые добавления в корзину.`);
            return;
        }

            if (cartsCount['carts'] < MAX_TOTAL_ACTIVE_TASKS && totalActiveTasks < MAX_TOTAL_ACTIVE_TASKS) {
            const user = await db3.collection('users').findOne({ _id: like.user });
            const balanceRequiredForOneAction = PRICE_PER_CART_LIKE;
            if (user.balance < balanceRequiredForOneAction) {
                console.error(`У юзера с ID ${like.user.toString()} недостаточно средств на балансе для выполнения следующего добавления в корзину.`);
                
                await db3.collection('carts').updateOne(
                    { _id: new ObjectId(idString) },
                    { $set: { status: 'nofunds' } }
                );

                await sendErrorToTelegram(`У юзера с ID ${like.user.toString()} недостаточно средств на балансе для выполнения следующего добавления в корзину.`, 'processCartLike');

                await totalActiveTasks--;
                await cartsCount['carts']--;
                
                return;
            }

            let proxy;
            let phoneNumber;
            let accountId;

            proxy = await getProxyWithRetries();
            const accountInfo = await getRandomPhoneNumberWithRetries(idString, 'carts');
            accountId = accountInfo.id;
            phoneNumber = accountInfo.number;

            const outcome = await addToCartHandler(phoneNumber, proxy, like.article, like.query, like.size);

            switch (outcome) {
                case 'SUCCESS':
                    // console.log('addToCartHandler вернула SUCCESS, изменяем количество в базе данных:', idString);
                    
                    const result = await db3.collection('carts').updateOne(
                        { _id: new ObjectId(idString) },
                        {
                            $inc: { totalAmountMade: 1 },
                            $push: { accountsUsed: accountId }
                        }
                    );
                    
                    if (result.modifiedCount !== 1) {
                        throw new Error(`Не удалось обновить прогресс для likeId ${idString} и артикула ${like.article}`);
                    }

                    const paymentTask = {
                        user: like.user,
                        status: 'created',
                        type: like.type,
                        taskId: like._id,
                        createdDate: await getCurrentDateInMoscow(),
                        sum: PRICE_PER_CART_LIKE
                    };
                    
                    try {
                        const insertResult = await db2.collection('Task').insertOne(paymentTask);
                        if (insertResult.acknowledged !== true || insertResult.insertedId == null) {
                            await sendErrorToTelegram('Не удалось вставить новый Task на списание баланса.');
                            throw new Error('Не удалось вставить новый Task на списание баланса.');
                        }
                        const paymentHistoryRecord = {
                            user: like.user,
                            summ: PRICE_PER_CART_LIKE,
                            typeoperations: 'Расход',
                            basisoperation: `Корзина ${like._id.toString()}`,
                            dataoperation: new Date().toISOString(),
                            comment: '',
                            type: like.type
                        };
                    
                        const insertPaymentHistoryResult = await db3.collection('paymenthistories').insertOne(paymentHistoryRecord);
                        if (insertPaymentHistoryResult.acknowledged !== true || insertPaymentHistoryResult.insertedId == null) {
                            await sendErrorToTelegram('Не удалось записать историю операций в коллекцию paymenthistories.');
                            throw new Error('Не удалось записать историю операций в коллекцию paymenthistories.');
                        }

                        console.log(`Добавление в корзину для likeId ${idString} успешно обработано`);

                    } catch (error) {
                        console.error(`Ошибка при добавлении записей в коллекции Task и/или paymenthistories: ${error.message}`);
                        await sendErrorToTelegram(`Ошибка при добавлении записей для пользователя с ID ${like.user.toString()} в коллекции Task и/или paymenthistories: ${error.message}`, 'processCartLike');
                        throw error;
                    }

                    await totalActiveTasks--;
                    await cartsCount['carts']--; 
                    
                    break;
                
                case 'PRODUCT_NOT_FOUND':
                    console.warn(`Продукт не найден для аккаунта: ${phoneNumber}`);
                    reAddToCartsQueue(task.cartsRecord, task.retries);
                    break;
                case 'NO_AVAILABLE_PROXY':
                    await reAddToCartsQueueWithTimeout(task.cartsRecord, task.retries);
                case 'ERROR':
                case 'ERROR_MAX_RETRIES':
                    console.warn(`Превышено масимальное количество попыток добавления в корзину для номера: ${phoneNumber} и артикула ${like.article}`);
                    
                    await db3.collection('carts').updateOne(
                        { _id: new ObjectId(idString) },
                        { $push: { accountsUsed: accountId } }
                    );
                    await reAddToCartsQueue(task.cartsRecord, task.retries);
                    break;

                default:
                    console.error(`Неизвестный результат от addToCartHandler: ${outcome}, артикул ${like.article}`);
                    reAddToCartsQueue(task.cartsRecord, task.retries);
                    break;
            }

            let updatedLike = await db3.collection('carts').findOne({ _id: new ObjectId(idString) });
                if (!updatedLike) {
                    throw new Error(`Не найдена обновленная запись для likeId ${idString} после операции добавления в корзину.`);
                }

            let updatedRemainingActions = updatedLike.amount - updatedLike.totalAmountMade;


            if (updatedRemainingActions == 0) {
                const updateResult = await db3.collection('carts').updateOne(
                    { _id: new ObjectId(idString) },
                    {
                        $set: { 
                            status: 'completed',
                            endedDate: await getCurrentDateInMoscow()
                        }
                    }
                );
    
                if (updateResult.modifiedCount !== 1) {
                    console.warn(`Не удалось установить статус 'completed' для likeId ${idString}`);
                } else {
                    console.log(`Задача на добавление в корзину с likeId ${idString} завершена.`);
                }
            }

            if (phoneNumber) {
                await db.collection('accounts').updateOne({ number: phoneNumber }, { $set: { status: 'free' } });
            }

            if (proxy) {
                const isProxyWorking = await checkProxy(proxy);
                const updateData = isProxyWorking ? { status: 'free', lastUsedIP: isProxyWorking } : { status: 'free' };
                await db.collection('proxies').updateOne({ proxy: proxy }, { $set: updateData });
            }
        }

    } catch (error) {
        const errorMessage = `Ошибка при обработке добавления в корзину likeId ${idString}: ${error.message}`;
        console.error(errorMessage);
        await sendErrorToTelegram(errorMessage, 'processCartLike');

        throw error;
    }
}