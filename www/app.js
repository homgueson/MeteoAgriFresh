// app.js – Version complète avec prévisions, alertes, conseils, géolocalisation, carte interactive et zoom sur localité

// ========== CONFIGURATION ==========
const API_KEY = '32bd10cbd151c4bf7bac25ff3150fd4e';
const DEFAULT_CITY = "N'Djamena";

// ========== ÉLÉMENTS DOM ==========
const cityNameEl = document.getElementById('city-name');
const tempEl = document.getElementById('temp');
const conditionEl = document.getElementById('condition');
const humidityEl = document.getElementById('humidity');
const rainEl = document.getElementById('rain');
const windEl = document.getElementById('wind');
const forecastEl = document.getElementById('forecast');
const alertsEl = document.getElementById('alerts');
const adviceEl = document.getElementById('advice');
const updateTimeEl = document.getElementById('update-time');

// ========== VARIABLES POUR LA CARTE ==========
let currentMap = null;
let lastMapCoords = null;

// ========== FONCTION UNIFIÉE POUR LA CARTE (création / recentrage) ==========
function updateMap(lat, lon, zoomLevel = 12) {
    // Éviter les mises à jour inutiles
    if (lastMapCoords && lastMapCoords.lat === lat && lastMapCoords.lon === lon) {
        console.log('Carte déjà centrée sur ces coordonnées');
        return;
    }
    lastMapCoords = { lat, lon };

    const mapContainer = document.getElementById('map');
    if (!mapContainer) {
        console.error('Conteneur #map introuvable');
        return;
    }

    if (currentMap) {
        // Recentrage et changement de zoom
        currentMap.setView([lat, lon], zoomLevel);
        // Supprimer les anciens marqueurs/cercle pour les remplacer
        currentMap.eachLayer(layer => {
            if (layer instanceof L.Marker || layer instanceof L.Circle) {
                currentMap.removeLayer(layer);
            }
        });
    } else {
        // Première initialisation
        if (typeof L === 'undefined') {
            console.error('Leaflet non chargé');
            return;
        }
        currentMap = L.map('map').setView([lat, lon], zoomLevel);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap contributors'
        }).addTo(currentMap);
    }

    // Marqueur avec le nom de la localité
    const popupText = `📍 ${cityNameEl.textContent}`;
    L.marker([lat, lon]).addTo(currentMap)
        .bindPopup(popupText)
        .openPopup();

    // Cercle de précision (rayon 1 km)
    L.circle([lat, lon], {
        color: '#2E7D32',
        fillColor: '#4CAF50',
        fillOpacity: 0.2,
        radius: 1000
    }).addTo(currentMap);

    // Forcer le redimensionnement (utile sur mobile / Cordova)
    setTimeout(() => {
        if (currentMap) currentMap.invalidateSize();
    }, 200);
}

// ========== FONCTIONS MÉTÉO (ville) ==========
async function loadWeather(city = DEFAULT_CITY) {
    try {
        const currentRes = await fetch(
            `https://api.openweathermap.org/data/2.5/weather?q=${city}&units=metric&lang=fr&appid=${API_KEY}`
        );
        const currentData = await currentRes.json();
        if (currentData.cod !== 200) throw new Error(currentData.message);

        updateCurrentWeather(currentData);

        // Mise à jour de la carte avec les coordonnées de la ville
        const lat = currentData.coord.lat;
        const lon = currentData.coord.lon;
        updateMap(lat, lon, 12);   // zoom 12 pour une vue ville

        // Prévisions (format 3h)
        const forecastRes = await fetch(
            `https://api.openweathermap.org/data/2.5/forecast?q=${city}&units=metric&lang=fr&appid=${API_KEY}`
        );
        const forecastData = await forecastRes.json();
        const dailyForecasts = forecastData.list.filter(item => item.dt_txt.includes('12:00:00')).slice(0, 3);
        displayForecast(dailyForecasts);

        generateAlerts(currentData);
        generateAdvice(currentData, dailyForecasts);

        updateTimeEl.textContent = new Date().toLocaleString('fr-FR', {
            hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric'
        });
    } catch (error) {
        console.error(error);
        alert(`Erreur : ${error.message}. Vérifiez le nom de la ville ou votre connexion.`);
    }
}

function updateCurrentWeather(data) {
    cityNameEl.textContent = data.name;
    tempEl.innerHTML = `${Math.round(data.main.temp)}°C`;
    conditionEl.textContent = data.weather[0].description;
    humidityEl.textContent = `${data.main.humidity}%`;
    windEl.textContent = `${Math.round(data.wind.speed * 3.6)} km/h`;
    const rain = data.rain ? data.rain['1h'] || data.rain['3h'] || 0 : 0;
    rainEl.textContent = `${rain} mm`;
}

// ========== FONCTIONS AVEC COORDONNÉES (One Call 3.0) ==========
async function loadWeatherByCoords(lat, lon) {
    try {
        const response = await fetch(
            `https://api.openweathermap.org/data/3.0/onecall?lat=${lat}&lon=${lon}&units=metric&lang=fr&exclude=minutely,hourly&appid=${API_KEY}`
        );
        const data = await response.json();
        if (response.status !== 200) throw new Error(data.message);

        // Mise à jour de l'interface
        cityNameEl.textContent = `Position (${lat.toFixed(2)}, ${lon.toFixed(2)})`;
        tempEl.innerHTML = `${Math.round(data.current.temp)}°C`;
        conditionEl.textContent = data.current.weather[0].description;
        humidityEl.textContent = `${data.current.humidity}%`;
        windEl.textContent = `${Math.round(data.current.wind_speed * 3.6)} km/h`;
        const rain = data.current.rain ? data.current.rain['1h'] || 0 : 0;
        rainEl.textContent = `${rain} mm`;

        // Carte
        updateMap(lat, lon, 12);

        // Prévisions One Call (daily)
        displayForecastFromDaily(data.daily.slice(0, 3));

        // Alertes One Call
        if (data.alerts && data.alerts.length > 0) {
            displayAlertsOneCall(data.alerts);
        } else {
            alertsEl.innerHTML = '<div class="alert-item info">✅ Aucune alerte majeure aujourd’hui.</div>';
        }

        // Conseils (en passant les données daily)
        generateAdvice(data.current, data.daily);

        updateTimeEl.textContent = new Date().toLocaleString('fr-FR', {
            hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric'
        });
    } catch (error) {
        console.error('Erreur loadWeatherByCoords:', error);
        alert('Erreur de géolocalisation. Utilisation de la ville par défaut.');
        loadWeather(DEFAULT_CITY);
    }
}

// Affichage des prévisions depuis l'API standard (3h -> quotidien)
function displayForecast(forecasts) {
    const days = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
    let html = '';
    forecasts.forEach((day, index) => {
        const date = new Date(day.dt_txt);
        const dayName = index === 0 ? 'Demain' : days[date.getDay()];
        const icon = day.weather[0].icon;
        html += `
            <div class="forecast-day">
                <h3>${dayName}</h3>
                <img src="https://openweathermap.org/img/wn/${icon}.png" alt="icône">
                <div class="temp">${Math.round(day.main.temp)}°C</div>
                <div>${day.weather[0].description}</div>
                <div><i class="fas fa-tint"></i> ${day.main.humidity}%</div>
                <div><i class="fas fa-cloud-rain"></i> ${day.rain ? day.rain['3h'] || 0 : 0} mm</div>
            </div>
        `;
    });
    forecastEl.innerHTML = html;
}

// Affichage des prévisions depuis l'API One Call (daily)
function displayForecastFromDaily(dailyForecasts) {
    const days = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
    let html = '';
    dailyForecasts.forEach((day, index) => {
        const date = new Date(day.dt * 1000);
        const dayName = index === 0 ? 'Demain' : days[date.getDay()];
        const icon = day.weather[0].icon;
        const rain = day.rain ? day.rain : 0;
        html += `
            <div class="forecast-day">
                <h3>${dayName}</h3>
                <img src="https://openweathermap.org/img/wn/${icon}.png" alt="icône">
                <div class="temp">${Math.round(day.temp.day)}°C</div>
                <div>${day.weather[0].description}</div>
                <div><i class="fas fa-tint"></i> ${day.humidity}%</div>
                <div><i class="fas fa-cloud-rain"></i> ${rain} mm</div>
            </div>
        `;
    });
    forecastEl.innerHTML = html;
}

function displayAlertsOneCall(alerts) {
    let html = '';
    alerts.forEach(alert => {
        html += `<div class="alert-item">⚠️ <strong>${alert.event}</strong> : ${alert.description}</div>`;
    });
    alertsEl.innerHTML = html;
}

// ========== GÉNÉRATION DES ALERTES ET CONSEILS ==========
function generateAlerts(currentData) {
    const alerts = [];
    const windSpeed = currentData.wind.speed * 3.6;
    const rain = currentData.rain ? currentData.rain['1h'] || 0 : 0;

    if (windSpeed > 50) alerts.push('⚠️ Vents très forts (rafales > 50 km/h). Sécurisez vos serres.');
    else if (windSpeed > 30) alerts.push('⚠️ Vents modérés. Évitez les traitements en hauteur.');

    if (rain > 10) alerts.push('🌧️ Fortes pluies. Risque d’inondation temporaire.');
    else if (rain > 5) alerts.push('🌧️ Pluies modérées. Bonne occasion pour laisser les cultures se ressourcer.');

    if (currentData.main.temp > 40) alerts.push('🔥 Canicule ! Hydratez le bétail et protégez les semis.');
    else if (currentData.main.temp < 5) alerts.push('❄️ Gel possible. Rentrez les plants sensibles.');

    if (currentData.main.humidity > 90) alerts.push('💧 Humidité très élevée. Surveillez les maladies cryptogamiques.');

    alertsEl.innerHTML = alerts.length
        ? alerts.map(a => `<div class="alert-item">${a}</div>`).join('')
        : '<div class="alert-item info">✅ Aucune alerte majeure aujourd’hui.</div>';
}

function generateAdvice(currentData, forecasts) {
    const advice = [];
    // Compatible à la fois avec l'API standard (main) et One Call (direct)
    const temp = currentData.main?.temp ?? currentData.temp;
    const rain = currentData.rain ? (currentData.rain['1h'] || 0) : 0;
    const humidity = currentData.main?.humidity ?? currentData.humidity;
    const wind = (currentData.wind?.speed ?? currentData.wind_speed ?? 0) * 3.6;

    if (rain === 0 && temp > 15 && temp < 30) {
        advice.push('🌱 Conditions idéales pour les semis de saison sèche.');
    } else if (rain > 2 && rain < 10) {
        advice.push('💧 Pluies bénéfiques – réduisez ou arrêtez l’irrigation aujourd’hui.');
    }

    if (humidity > 80) {
        advice.push('🍂 Humidité élevée – aérez les serres et surveillez le mildiou.');
    }

    if (wind > 20) {
        advice.push('🌬️ Vent soutenu – reportez les traitements phytosanitaires.');
    }

    // Vérification pluie future (adapté aux deux formats)
    let hasRainSoon = false;
    if (forecasts && forecasts.length) {
        if (forecasts[0].rain !== undefined) { // One Call daily
            hasRainSoon = forecasts.some(f => (f.rain || 0) > 5);
        } else { // API standard (list)
            hasRainSoon = forecasts.some(f => (f.rain?.['3h'] || 0) > 5);
        }
    }
    if (hasRainSoon) {
        advice.push('📅 De la pluie est annoncée. Préparez vos parcelles pour profiter de l’eau.');
    }

    if (advice.length === 0) {
        advice.push('🌿 Pas de conseil spécifique aujourd’hui. Continuez l’entretien régulier.');
    }

    adviceEl.innerHTML = advice.map(a => `<p>${a}</p>`).join('');
}

// ========== GÉOLOCALISATION ==========
function getLocationAndWeather() {
    if (navigator.geolocation) {
        cityNameEl.textContent = "Recherche de votre position...";
        navigator.geolocation.getCurrentPosition(showPosition, showError);
    } else {
        alert("La géolocalisation n'est pas supportée. Utilisation de la ville par défaut.");
        loadWeather(DEFAULT_CITY);
    }
}

function showPosition(position) {
    const lat = position.coords.latitude;
    const lon = position.coords.longitude;
    console.log(`Position obtenue : ${lat}, ${lon}`);
    loadWeatherByCoords(lat, lon);
}

function showError(error) {
    let message = "";
    switch (error.code) {
        case error.PERMISSION_DENIED:
            message = "Vous avez refusé la géolocalisation. Utilisation de la ville par défaut.";
            break;
        case error.POSITION_UNAVAILABLE:
            message = "Position indisponible. Utilisation de la ville par défaut.";
            break;
        case error.TIMEOUT:
            message = "Délai de géolocalisation dépassé. Utilisation de la ville par défaut.";
            break;
        default:
            message = "Erreur inconnue. Utilisation de la ville par défaut.";
    }
    alert(message);
    loadWeather(DEFAULT_CITY);
}

// ========== BASE DE DONNÉES SQLITE (inchangée) ==========
let db;

function onDeviceReady() {
    console.log('Appareil prêt, initialisation de la base de données...');
    db = window.sqlitePlugin.openDatabase({
        name: 'meteo.db',
        location: 'default'
    });
    window.appDatabase = db;
    initializeDatabaseTables(db);
}

function initializeDatabaseTables(db) {
    console.log('Création des tables...');
    db.transaction(function(tx) {
        tx.executeSql(
            `CREATE TABLE IF NOT EXISTS favorite_cities (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                city_name TEXT NOT NULL UNIQUE,
                country_code TEXT,
                added_date TEXT
            )`,
            [],
            function() { console.log('Table favorite_cities prête.'); },
            function(tx, error) { console.error('Erreur création table favorite_cities:', error.message); }
        );
        tx.executeSql(
            `CREATE TABLE IF NOT EXISTS weather_cache (
                city_name TEXT PRIMARY KEY,
                weather_data TEXT NOT NULL,
                last_updated INTEGER
            )`,
            [],
            function() { console.log('Table weather_cache prête.'); },
            function(tx, error) { console.error('Erreur création table weather_cache:', error.message); }
        );
    }, function(error) {
        console.log('Erreur de transaction: ' + error.message);
    }, function() {
        console.log('Transaction de création des tables réussie !');
    });
}

function addFavoriteCity(cityName, countryCode) {
    if (!db) return;
    const query = 'INSERT INTO favorite_cities (city_name, country_code, added_date) VALUES (?, ?, ?)';
    const today = new Date().toISOString().split('T')[0];
    db.transaction(tx => {
        tx.executeSql(query, [cityName, countryCode, today],
            () => console.log(`${cityName} ajoutée aux favoris.`),
            (tx, error) => console.error('Erreur ajout favori:', error.message)
        );
    });
}

function getFavoriteCities(callback) {
    if (!db) return;
    db.transaction(tx => {
        tx.executeSql('SELECT * FROM favorite_cities ORDER BY added_date DESC', [],
            (tx, resultSet) => {
                const cities = [];
                for (let i = 0; i < resultSet.rows.length; i++) {
                    cities.push(resultSet.rows.item(i));
                }
                callback(cities);
            },
            (tx, error) => console.error('Erreur lecture favoris:', error.message)
        );
    });
}

function cacheWeatherData(cityName, weatherData) {
    if (!db) return;
    const query = `INSERT OR REPLACE INTO weather_cache (city_name, weather_data, last_updated)
                   VALUES (?, ?, ?)`;
    const now = Date.now();
    db.transaction(tx => {
        tx.executeSql(query, [cityName, JSON.stringify(weatherData), now],
            () => console.log(`Cache météo mis à jour pour ${cityName}`),
            (tx, error) => console.error('Erreur cache météo:', error.message)
        );
    });
}

function getCachedWeather(cityName, callback) {
    if (!db) return;
    db.transaction(tx => {
        tx.executeSql('SELECT * FROM weather_cache WHERE city_name = ?', [cityName],
            (tx, resultSet) => {
                if (resultSet.rows.length > 0) {
                    const cached = resultSet.rows.item(0);
                    callback(JSON.parse(cached.weather_data), cached.last_updated);
                } else {
                    callback(null, null);
                }
            },
            (tx, error) => console.error('Erreur lecture cache:', error.message)
        );
    });
}

// ========== EXPORT/IMPORT (inchangé) ==========
function exportFavorites() {
    getFavoriteCities((cities) => {
        const dataStr = JSON.stringify(cities, null, 2);
        const blob = new Blob([dataStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `meteo-favoris-${new Date().toISOString().slice(0,10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
    });
}

function importCitiesToDatabase(cities) {
    if (!db) return;
    db.transaction(tx => {
        tx.executeSql('DELETE FROM favorite_cities', [], () => {
            cities.forEach(city => {
                tx.executeSql(
                    'INSERT INTO favorite_cities (city_name, country_code, added_date) VALUES (?, ?, ?)',
                    [city.city_name, city.country_code || '', city.added_date || new Date().toISOString().split('T')[0]],
                    null,
                    (tx, error) => console.error('Erreur import:', error.message)
                );
            });
        });
    }, (error) => alert('Erreur lors de l’import'), () => {
        alert('Import terminé !');
    });
}

// ========== FIREBASE (inchangé) ==========
let dbFirestore;

function initFirebase() {
    // Remplacez par votre configuration Firebase réelle
    const firebaseConfig = {
        apiKey: "AIzaSy...",   // À remplacer
        authDomain: "...",
        projectId: "...",
        storageBucket: "...",
        messagingSenderId: "...",
        appId: "..."
    };
    firebase.initializeApp(firebaseConfig);
    dbFirestore = firebase.firestore();
    console.log('Firebase initialisé');
}

function getDeviceId() {
    let deviceId = localStorage.getItem('deviceId');
    if (!deviceId) {
        deviceId = 'device_' + Math.random().toString(36).substr(2, 9);
        localStorage.setItem('deviceId', deviceId);
    }
    return deviceId;
}

async function uploadFavoritesToFirebase() {
    const cities = await new Promise(resolve => getFavoriteCities(resolve));
    const deviceId = getDeviceId();
    for (const city of cities) {
        try {
            await dbFirestore.collection('favorites').doc(deviceId + '_' + city.city_name).set({
                city_name: city.city_name,
                country_code: city.country_code || '',
                added_date: city.added_date,
                deviceId: deviceId,
                syncedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
        } catch (error) {
            console.error('Erreur upload:', error);
        }
    }
    console.log('Upload terminé');
}

async function downloadFavoritesFromFirebase() {
    const snapshot = await dbFirestore.collection('favorites').get();
    const remoteCities = [];
    snapshot.forEach(doc => remoteCities.push(doc.data()));
    const localCities = await new Promise(resolve => getFavoriteCities(resolve));
    const localNames = new Set(localCities.map(c => c.city_name));
    for (const city of remoteCities) {
        if (!localNames.has(city.city_name)) {
            db.transaction(tx => {
                tx.executeSql(
                    'INSERT INTO favorite_cities (city_name, country_code, added_date) VALUES (?, ?, ?)',
                    [city.city_name, city.country_code || '', city.added_date]
                );
            });
        }
    }
    console.log('Téléchargement et fusion terminés');
}

async function syncFavorites() {
    await uploadFavoritesToFirebase();
    await downloadFavoritesFromFirebase();
    alert('Synchronisation terminée !');
}

// ========== GESTIONNAIRES D'ÉVÉNEMENTS ==========
document.addEventListener('deviceready', () => {
    onDeviceReady();
    initFirebase();
    getLocationAndWeather();   // Lance la géolocalisation
}, false);

document.getElementById('search-btn').addEventListener('click', () => {
    const input = document.getElementById('search-input');
    if (input.value.trim() !== '') {
        loadWeather(input.value.trim());
    }
});

document.getElementById('search-input').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        document.getElementById('search-btn').click();
    }
});

document.getElementById('export-btn').addEventListener('click', exportFavorites);
document.getElementById('import-btn').addEventListener('click', () => {
    document.getElementById('import-file').click();
});
document.getElementById('import-file').addEventListener('change', (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const cities = JSON.parse(e.target.result);
            importCitiesToDatabase(cities);
        } catch (error) {
            alert('Fichier invalide');
        }
    };
    reader.readAsText(file);
});
document.getElementById('sync-btn').addEventListener('click', syncFavorites);

// ========== RAFRAÎCHISSEMENT PÉRIODIQUE (toutes les 30 min) ==========
setInterval(() => {
    const currentCity = cityNameEl.textContent;
    if (currentCity.includes('Position')) {
        // Pas de récupération automatique des coordonnées ; on ne fait rien ou on recharge via la ville par défaut
        loadWeather(DEFAULT_CITY);
    } else if (currentCity && currentCity !== '--' && !currentCity.includes('Position')) {
        loadWeather(currentCity);
    } else {
        loadWeather(DEFAULT_CITY);
    }
}, 30 * 60 * 1000);