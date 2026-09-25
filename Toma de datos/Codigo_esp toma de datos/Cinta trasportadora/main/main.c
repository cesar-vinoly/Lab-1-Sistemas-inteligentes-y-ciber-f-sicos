/*
 * ENSAYO DE RESPUESTA AL ESCALON - CINTA TRANSPORTADORA UTEC
 * ESP32-WROOM-32D + TMC2208 (STEP/DIR) + encoder solidario al rodillo
 * Envio de datos por Wi-Fi (STA) + TCP persistente (sin USB durante el ensayo)
 *
 * GPIO, logica STEP/DIR/ENABLE y criterio de conteo del encoder
 * tomados del .ino de referencia (cinta_utec.ino). No se usa API Arduino.
 *
 * Fase 1 (0 .. TIEMPO_REPOSO_MS):        motor detenido, STEP = 0 Hz
 * Fase 2 (instante = TIEMPO_REPOSO_MS):  escalon 0 -> FREQ_ESCALON_HZ
 * Fase 3 (resto del ensayo):             STEP = FREQ_ESCALON_HZ constante
 *
 * STEP generado por LEDC (hardware). Encoder contado por PCNT (hardware),
 * solo flanco de subida (RISING), igual criterio que el .ino.
 *
 * El motor NO se habilita si no hay conexion TCP con el servidor.
 * NO implementa PID ni rampas. Ensayo unico, no se repite.
 */

#include <stdio.h>
#include <stdint.h>
#include <stdbool.h>
#include <string.h>
#include <inttypes.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/event_groups.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_log.h"
#include "esp_err.h"
#include "nvs_flash.h"
#include "lwip/sockets.h"
#include "lwip/netdb.h"
#include "driver/gpio.h"
#include "driver/ledc.h"
#include "driver/pulse_cnt.h"
#include "esp_timer.h"

// =====================================================
// WI-FI / SERVIDOR (configurar antes de compilar)
// =====================================================
#define WIFI_SSID       "Poseidon"
#define WIFI_PASSWORD   "1994@DiosdelMar"

#define SERVER_IP       "192.168.1.150"
#define SERVER_PORT     5000

// =====================================================
// CONFIGURACION DEL ENSAYO
// =====================================================
#define FREQ_ESCALON_HZ         1500     // Hz = pasos/s aplicados en el escalon
#define TIEMPO_REPOSO_MS        20000    // Fase 1: motor detenido
#define TIEMPO_RESPUESTA_MS     20000    // Fase 3: motor a FREQ_ESCALON_HZ
#define PERIODO_MUESTREO_MS     10       // 100 muestras/s
#define ENCODER_COUNTS_PER_REV  20       // = ENCODER_PPR del .ino (disco solidario al rodillo)

// Reintentos de conexion TCP antes de desistir (no arranca el motor si falla)
#define TCP_REINTENTOS          15
#define TCP_ESPERA_REINTENTO_MS 2000

// =====================================================
// GPIO (tomados de cinta_utec.ino, NO se cambia el cableado)
// =====================================================
#define STEP_GPIO       25
#define DIR_GPIO        26
#define EN_GPIO         27   // ENABLE activo en LOW (igual que el .ino)
#define MS1_GPIO        32
#define MS2_GPIO        33
#define ENCODER_GPIO    23   // unico canal de encoder en el .ino (RISING), sin B/direccion

// Tabla de microstepping standalone TMC2208 (tomada del .ino):
// MS1=LOW MS2=LOW -> 1/8 (la necesaria para este ensayo)

// =====================================================
// LEDC: genera el STEP como onda cuadrada fija, 100% hardware
// =====================================================
#define LEDC_MODE       LEDC_LOW_SPEED_MODE
#define LEDC_TIMER_SEL  LEDC_TIMER_0
#define LEDC_CHAN_SEL   LEDC_CHANNEL_0
#define LEDC_RES_BITS   LEDC_TIMER_10_BIT
#define LEDC_DUTY_50    (1 << 9)   // 512/1024 = 50%

static const char *TAG = "ensayo";

// =====================================================
// ESTADO GLOBAL
// =====================================================
static EventGroupHandle_t s_wifi_event_group;
#define WIFI_CONNECTED_BIT BIT0
#define WIFI_TIMEOUT_MS     30000

static int s_sock = -1;
static pcnt_unit_handle_t s_pcnt_unit = NULL;

static volatile bool s_escalon_aplicado  = false;
static volatile bool s_ensayo_finalizado = false;

static int64_t s_t_inicio_us   = 0;
static int32_t s_encoder_total = 0;

static esp_timer_handle_t s_timer_muestreo;
static esp_timer_handle_t s_timer_escalon;
static esp_timer_handle_t s_timer_fin;

// =====================================================
// WI-FI STA
// =====================================================
static void wifi_event_handler(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        ESP_LOGI(TAG, "Wi-Fi iniciado. Intentando conectar a \"%s\"...", WIFI_SSID);

        esp_err_t err = esp_wifi_connect();
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "esp_wifi_connect() fallo: %s", esp_err_to_name(err));
        }

    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_CONNECTED) {
        ESP_LOGI(TAG, "Asociado correctamente al punto de acceso");

    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        wifi_event_sta_disconnected_t *evt =
            (wifi_event_sta_disconnected_t *)data;

        ESP_LOGW(TAG, "Wi-Fi desconectado. reason=%d", evt->reason);
        xEventGroupClearBits(s_wifi_event_group, WIFI_CONNECTED_BIT);

        esp_err_t err = esp_wifi_connect();
        if (err != ESP_OK) {
            ESP_LOGE(TAG,
                     "Error al reintentar Wi-Fi: %s",
                     esp_err_to_name(err));
        }

    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *event = (ip_event_got_ip_t *)data;

        ESP_LOGI(TAG, "IP obtenida: " IPSTR,
                 IP2STR(&event->ip_info.ip));
        ESP_LOGI(TAG, "Gateway: " IPSTR,
                 IP2STR(&event->ip_info.gw));

        xEventGroupSetBits(s_wifi_event_group, WIFI_CONNECTED_BIT);
    }
}

static bool wifi_conectar(void)
{
    s_wifi_event_group = xEventGroupCreate();
    if (s_wifi_event_group == NULL) {
        ESP_LOGE(TAG, "No se pudo crear el EventGroup de Wi-Fi");
        return false;
    }

    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));

    ESP_ERROR_CHECK(esp_event_handler_register(
        WIFI_EVENT, ESP_EVENT_ANY_ID, &wifi_event_handler, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(
        IP_EVENT, IP_EVENT_STA_GOT_IP, &wifi_event_handler, NULL));

    wifi_config_t wifi_config = {
        .sta = {
            .ssid = WIFI_SSID,
            .password = WIFI_PASSWORD,
        },
    };

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi_config));
    ESP_ERROR_CHECK(esp_wifi_start());

    ESP_LOGI(TAG, "Conectando a Wi-Fi SSID=\"%s\"...", WIFI_SSID);

    EventBits_t bits = xEventGroupWaitBits(
        s_wifi_event_group,
        WIFI_CONNECTED_BIT,
        pdFALSE,
        pdTRUE,
        pdMS_TO_TICKS(WIFI_TIMEOUT_MS));

    if (bits & WIFI_CONNECTED_BIT) {
        ESP_LOGI(TAG, "Wi-Fi conectado correctamente");
        return true;
    }

    ESP_LOGE(TAG, "Timeout de %d ms esperando conexion Wi-Fi", WIFI_TIMEOUT_MS);
    return false;
}

// =====================================================
// TCP CLIENTE (conexion persistente al servidor)
// =====================================================
static bool tcp_conectar(void)
{
    struct sockaddr_in dest = {
        .sin_family = AF_INET,
        .sin_port   = htons(SERVER_PORT),
    };
    dest.sin_addr.s_addr = inet_addr(SERVER_IP);

    for (int intento = 1; intento <= TCP_REINTENTOS; intento++) {
        s_sock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
        if (s_sock < 0) {
            vTaskDelay(pdMS_TO_TICKS(TCP_ESPERA_REINTENTO_MS));
            continue;
        }

        if (connect(s_sock, (struct sockaddr *)&dest, sizeof(dest)) == 0) {
            ESP_LOGI(TAG, "Conectado al servidor TCP %s:%d", SERVER_IP, SERVER_PORT);
            return true;
        }

        ESP_LOGW(TAG, "Intento %d/%d de conexion TCP fallido", intento, TCP_REINTENTOS);
        close(s_sock);
        s_sock = -1;
        vTaskDelay(pdMS_TO_TICKS(TCP_ESPERA_REINTENTO_MS));
    }

    return false;
}

static void tcp_enviar_linea(const char *linea)
{
    if (s_sock < 0) {
        return;
    }
    size_t len = strlen(linea);
    size_t enviado = 0;
    while (enviado < len) {
        int n = send(s_sock, linea + enviado, len - enviado, 0);
        if (n <= 0) {
            close(s_sock);
            s_sock = -1;
            return;
        }
        enviado += (size_t)n;
    }
}

// =====================================================
// GPIO STEP/DIR/EN/MS1/MS2
// =====================================================
static void gpio_inicializar(void)
{
    gpio_reset_pin(DIR_GPIO);
    gpio_set_direction(DIR_GPIO, GPIO_MODE_OUTPUT);

    gpio_reset_pin(EN_GPIO);
    gpio_set_direction(EN_GPIO, GPIO_MODE_OUTPUT);

    gpio_reset_pin(MS1_GPIO);
    gpio_set_direction(MS1_GPIO, GPIO_MODE_OUTPUT);

    gpio_reset_pin(MS2_GPIO);
    gpio_set_direction(MS2_GPIO, GPIO_MODE_OUTPUT);

    // Mismo sentido que usa el .ino por defecto al arrancar (DIR = HIGH)
    gpio_set_level(DIR_GPIO, 1);

    // Microstepping 1/8 (MS1=LOW, MS2=LOW segun tabla del .ino)
    gpio_set_level(MS1_GPIO, 0);
    gpio_set_level(MS2_GPIO, 0);

    // Habilitar driver (activo en LOW, igual que el .ino). Solo se llega
    // aca si la conexion TCP ya fue confirmada (ver app_main).
    gpio_set_level(EN_GPIO, 0);
}

// =====================================================
// LEDC: duty=0 -> pin en bajo (0 Hz efectivos, Fase 1)
//       duty=50% -> FREQ_ESCALON_HZ constante (Fases 2 y 3)
// =====================================================
static void step_ledc_inicializar(void)
{
    ledc_timer_config_t timer_cfg = {
        .speed_mode      = LEDC_MODE,
        .duty_resolution = LEDC_RES_BITS,
        .timer_num       = LEDC_TIMER_SEL,
        .freq_hz         = FREQ_ESCALON_HZ,
        .clk_cfg         = LEDC_AUTO_CLK,
    };
    ESP_ERROR_CHECK(ledc_timer_config(&timer_cfg));

    ledc_channel_config_t chan_cfg = {
        .gpio_num   = STEP_GPIO,
        .speed_mode = LEDC_MODE,
        .channel    = LEDC_CHAN_SEL,
        .timer_sel  = LEDC_TIMER_SEL,
        .duty       = 0,
        .hpoint     = 0,
    };
    ESP_ERROR_CHECK(ledc_channel_config(&chan_cfg));
}

static void step_aplicar_escalon(void)
{
    ledc_set_duty(LEDC_MODE, LEDC_CHAN_SEL, LEDC_DUTY_50);
    ledc_update_duty(LEDC_MODE, LEDC_CHAN_SEL);
}

static void step_detener(void)
{
    ledc_set_duty(LEDC_MODE, LEDC_CHAN_SEL, 0);
    ledc_update_duty(LEDC_MODE, LEDC_CHAN_SEL);
}

// =====================================================
// PCNT: cuenta pulsos del encoder por hardware.
// Mismo criterio que el .ino: solo flanco de subida (RISING).
// =====================================================
static void encoder_pcnt_inicializar(void)
{
    gpio_reset_pin(ENCODER_GPIO);
    gpio_set_direction(ENCODER_GPIO, GPIO_MODE_INPUT);
    gpio_set_pull_mode(ENCODER_GPIO, GPIO_PULLUP_ONLY);

    pcnt_unit_config_t unit_cfg = {
        .low_limit  = -30000,
        .high_limit = 30000,
    };
    ESP_ERROR_CHECK(pcnt_new_unit(&unit_cfg, &s_pcnt_unit));

    pcnt_glitch_filter_config_t filtro_cfg = {
        .max_glitch_ns = 1000, // rechazo minimo de ruido electrico
    };
    ESP_ERROR_CHECK(pcnt_unit_set_glitch_filter(s_pcnt_unit, &filtro_cfg));

    pcnt_chan_config_t chan_cfg = {
        .edge_gpio_num  = ENCODER_GPIO,
        .level_gpio_num = -1,  // una sola señal, sin pin de nivel/direccion
    };
    pcnt_channel_handle_t chan = NULL;
    ESP_ERROR_CHECK(pcnt_new_channel(s_pcnt_unit, &chan_cfg, &chan));

    // RISING -> incrementa; FALLING -> se ignora (= attachInterrupt(..., RISING))
    ESP_ERROR_CHECK(pcnt_channel_set_edge_action(chan,
                        PCNT_CHANNEL_EDGE_ACTION_INCREASE,
                        PCNT_CHANNEL_EDGE_ACTION_HOLD));
    ESP_ERROR_CHECK(pcnt_channel_set_level_action(chan,
                        PCNT_CHANNEL_LEVEL_ACTION_KEEP,
                        PCNT_CHANNEL_LEVEL_ACTION_KEEP));

    ESP_ERROR_CHECK(pcnt_unit_enable(s_pcnt_unit));
    ESP_ERROR_CHECK(pcnt_unit_clear_count(s_pcnt_unit));
    ESP_ERROR_CHECK(pcnt_unit_start(s_pcnt_unit));
}

// =====================================================
// CALLBACK: muestreo periodico (100 muestras/s, esp_timer = hardware)
// =====================================================
static void muestreo_cb(void *arg)
{
    if (s_ensayo_finalizado) {
        return;
    }

    int delta = 0;
    pcnt_unit_get_count(s_pcnt_unit, &delta);
    pcnt_unit_clear_count(s_pcnt_unit);

    s_encoder_total += delta;

    int32_t t_us = (int32_t)(esp_timer_get_time() - s_t_inicio_us);

    const char *estado = s_escalon_aplicado ? "STEP" : "OFF";
    int step_hz = s_escalon_aplicado ? FREQ_ESCALON_HZ : 0;

    // RPM aproximada por ventana de 10 ms: a bajas rpm queda cuantizada.
    // Por eso siempre se envian encoder_count y encoder_delta crudos
    // para recalcular la derivada correctamente en MATLAB.
    float rpm = ((float)delta / (float)ENCODER_COUNTS_PER_REV) *
                (60000.0f / (float)PERIODO_MUESTREO_MS);

    char linea[96];
    int n = snprintf(linea, sizeof(linea), "%" PRId32 ",%s,%d,%" PRId32 ",%d,%.3f\n",
                      t_us, estado, step_hz, s_encoder_total, delta, rpm);
    if (n > 0) {
        tcp_enviar_linea(linea);
    }
}

// =====================================================
// CALLBACK: aplica el escalon 0 -> FREQ_ESCALON_HZ
// =====================================================
static void escalon_cb(void *arg)
{
    step_aplicar_escalon();
    s_escalon_aplicado = true;
}

// =====================================================
// CALLBACK: fin del ensayo (no se repite)
// =====================================================
static void fin_cb(void *arg)
{
    step_detener();
    gpio_set_level(EN_GPIO, 1);   // deshabilitar driver (activo en LOW)
    s_ensayo_finalizado = true;
    esp_timer_stop(s_timer_muestreo);

    tcp_enviar_linea("END\n");

    if (s_sock >= 0) {
        close(s_sock);
        s_sock = -1;
    }
}

// =====================================================
// MAIN
// =====================================================
void app_main(void)
{
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ret = nvs_flash_init();
    }
    ESP_ERROR_CHECK(ret);

    if (!wifi_conectar()) {
        ESP_LOGE(TAG, "No se pudo conectar al Wi-Fi. El motor NO se habilita.");
        while (1) {
            vTaskDelay(pdMS_TO_TICKS(1000));
        }
    }

    if (!tcp_conectar()) {
        ESP_LOGE(TAG, "No se pudo conectar al servidor. El motor NO se habilita.");
        while (1) {
            vTaskDelay(pdMS_TO_TICKS(1000));
        }
    }

    // Solo se toca hardware del motor una vez confirmada la conexion TCP.
    gpio_inicializar();
    step_ledc_inicializar();
    encoder_pcnt_inicializar();

    const esp_timer_create_args_t muestreo_args = { .callback = &muestreo_cb, .name = "muestreo" };
    const esp_timer_create_args_t escalon_args  = { .callback = &escalon_cb,  .name = "escalon" };
    const esp_timer_create_args_t fin_args      = { .callback = &fin_cb,      .name = "fin_ensayo" };

    ESP_ERROR_CHECK(esp_timer_create(&muestreo_args, &s_timer_muestreo));
    ESP_ERROR_CHECK(esp_timer_create(&escalon_args, &s_timer_escalon));
    ESP_ERROR_CHECK(esp_timer_create(&fin_args, &s_timer_fin));

    tcp_enviar_linea("time_us,state,step_hz,encoder_count,encoder_delta,rpm\n");

    s_t_inicio_us = esp_timer_get_time();

    ESP_ERROR_CHECK(esp_timer_start_periodic(s_timer_muestreo,
                        (uint64_t)PERIODO_MUESTREO_MS * 1000ULL));
    ESP_ERROR_CHECK(esp_timer_start_once(s_timer_escalon,
                        (uint64_t)TIEMPO_REPOSO_MS * 1000ULL));
    ESP_ERROR_CHECK(esp_timer_start_once(s_timer_fin,
                        (uint64_t)(TIEMPO_REPOSO_MS + TIEMPO_RESPUESTA_MS) * 1000ULL));

    // El ensayo corre por hardware (LEDC + PCNT + esp_timer) y por el socket
    // TCP ya conectado; esta tarea solo mantiene vivo app_main.
    while (1) {
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}