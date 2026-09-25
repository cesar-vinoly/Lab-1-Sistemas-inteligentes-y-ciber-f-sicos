/*
 * CINTA UTEC -- C nativo / ESP-IDF, target esp32 (ESP32-WROOM-32D).
 * Referencia funcional: cinta_utec.ino suministrado por el usuario.
 *
 * COPIAR main/ y sdkconfig.cinta.defaults a la raiz del proyecto existente.
 * No sustituir el CMakeLists.txt de la raiz. El componente main solo compila
 * este main.c: retirar del registro cualquier app_main anterior.
 *
 * Configuracion separada, sin sobrescribir el sdkconfig anterior:
 * idf.py -B build-cinta -D SDKCONFIG=sdkconfig.cinta \
 *   -D SDKCONFIG_DEFAULTS=sdkconfig.cinta.defaults menuconfig
 * Menu "Cinta UTEC": SSID, clave y ws://IP_PC:8000/ws/esp32.
 * idf.py -B build-cinta build
 * idf.py -B build-cinta -p COMx flash monitor
 *
 * USB/UART0: 115200; Bluetooth SPP: CINTA_UTEC.
 * F, R, S, E, V0..100, M2/M4/M8/M16, O0..19.99, STATUS.
 * CR/LF o 120 ms sin caracteres en USB/BT; mensaje completo en WebSocket.
 * No hay botones GPIO en el .ino de referencia; no se asignan pines nuevos.
 *
 * Se conserva la mecanica del firmware: diametro 29.5 mm, NO el del visor.
 * La OLED y los tres transportes leen el mismo estado; sin modelo adicional.
 * USB/BT emiten cada 1000 ms; WS cada 250 ms, sin cambiar el muestreo original.
 * Si se pierde Wi-Fi/WS durante una marcha ordenada remotamente, se solicita
 * S (rampa original). USB/BT siguen disponibles. Una marcha ordenada localmente
 * no depende de la red. Reconectar nunca vuelve a arrancar el motor.
 */

#include <assert.h>
#include <ctype.h>
#include <errno.h>
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "sdkconfig.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "freertos/event_groups.h"
#include "freertos/timers.h"
#include "driver/gpio.h"
#include "driver/gptimer.h"
#include "driver/i2c_master.h"
#include "driver/uart.h"
#include "esp_attr.h"
#include "esp_bt.h"
#include "esp_bt_main.h"
#include "esp_gap_bt_api.h"
#include "esp_spp_api.h"
#include "esp_event.h"
#include "esp_idf_version.h"
#include "esp_intr_alloc.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_rom_sys.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "esp_websocket_client.h"
#include "nvs_flash.h"

#if !CONFIG_IDF_TARGET_ESP32
#error "Este firmware requiere ESP32 clasica: ESP32-WROOM-32D."
#endif
#if !CONFIG_BT_SPP_ENABLED || !CONFIG_BT_CLASSIC_ENABLED
#error "Aplicar sdkconfig.cinta.defaults: se debe conservar Bluetooth SPP."
#endif

#define STEP_PIN 25
#define DIR_PIN 26
#define EN_PIN 27
#define MS1_PIN 32
#define MS2_PIN 33
#define ENCODER_PIN 23
#define TRIG_PIN 18
#define ECHO_PIN 19
#define SDA_PIN 21
#define SCL_PIN 22
#define MOTOR_STEPS 200
#define MOTOR_GEAR_TEETH 19.0f
#define IDLER_GEAR_TEETH 19.0f
#define ROLLER_GEAR_TEETH 40.0f
#define ROLLER_DIAMETER_MM 29.5f
#define ENCODER_PPR 20.0f
#define BELT_LENGTH_CM 45.0f
#define MAX_MOTOR_RPM 150.0f
#define ACCEL_RPM_PER_SEC 120.0f
#define DECEL_RPM_PER_SEC 300.0f
#define SPEED_ERROR_LIMIT 15.0f
#define DIVERGENCE_MARGIN_MS 500U
#define ENCODER_STOP_TIMEOUT_US 2000000U
#define ENCODER_MIN_GAP_US 500U
#define ENCODER_SAMPLE_MS 1000U
#define HC_SAMPLE_MS 100U
#define HC_TIMEOUT_US 10000U
#define HC_ALPHA 0.35f
#define OLED_REFRESH_MS 200U
#define TELEMETRY_MS 1000U
#define WS_TELEMETRY_MS 250U
#define COMMAND_TIMEOUT_MS 120U
#define STEP_TIMER_HZ 10000000U
#define OLED_ADDRESS 0x3C
#define I2C_CLOCK_HZ 400000U
#define BT_NAME "CINTA_UTEC"
#define CMD_SIZE 48
#define LINE_SIZE 256
#define WIFI_READY BIT0
#define CONTROL_READY BIT1
#if CONFIG_FREERTOS_UNICORE
#define CONTROL_CORE 0
#else
#define CONTROL_CORE 1
#endif

typedef enum { STOPPED=0, FORWARD=1, REVERSE=-1 } direction_t;
typedef enum { SRC_USB=0, SRC_BT=1, SRC_WS=2, SRC_NONE=3 } source_t;
typedef struct {
    direction_t requested, actual;
    source_t owner;
    int percent, microsteps;
    float target_rpm, motor_rpm, roller_theory, roller_real;
    float speed_theory, speed_real, error, step_rate;
    float hc_offset, distance, position;
    bool hc_valid, first_hc, in_regime, divergence;
    uint32_t regime_since;
} machine_t;

typedef struct {
    source_t source;
    uint32_t epoch, sequence;
    char text[CMD_SIZE];
} command_t;
typedef struct { uint32_t epoch; char text[LINE_SIZE]; } tx_line_t;
typedef struct {
    bool wifi, ws, remote_lost, bt_busy, bt_congested;
    uint32_t ws_epoch, bt_epoch, bt_handle;
} links_t;
typedef struct {
    char text[CMD_SIZE];
    size_t used;
    uint32_t last_ms, epoch;
    bool discard;
} stream_t;

static machine_t machine={.owner=SRC_NONE,.percent=50,.microsteps=8,
                          .hc_offset=4.0f,.first_hc=true};
static machine_t snapshot;
static links_t links;
static stream_t streams[3];
static portMUX_TYPE state_mux=portMUX_INITIALIZER_UNLOCKED;
static portMUX_TYPE link_mux=portMUX_INITIALIZER_UNLOCKED;
static portMUX_TYPE input_mux=portMUX_INITIALIZER_UNLOCKED;
static QueueHandle_t commands, usb_tx, bt_tx, ws_tx;
static EventGroupHandle_t flags;
static TimerHandle_t wifi_retry;
static esp_websocket_client_handle_t ws_client;
static command_t urgent_stop[3];
static bool urgent_pending[3];
static uint32_t command_sequence;
static gptimer_handle_t step_timer;
static bool timer_running;
static float last_step_rate=-1.0f;
static portMUX_TYPE step_mux=portMUX_INITIALIZER_UNLOCKED;
static volatile bool step_enabled, step_high;
static portMUX_TYPE encoder_mux=portMUX_INITIALIZER_UNLOCKED;
static volatile uint32_t encoder_pulses, encoder_last_us;
static uint32_t encoder_ref_us;
static portMUX_TYPE echo_mux=portMUX_INITIALIZER_UNLOCKED;
static volatile bool echo_waiting, echo_risen, echo_ready;
static volatile uint32_t echo_start_us, echo_rise_us, echo_duration;
static i2c_master_dev_handle_t oled;
static uint8_t oled_frame[1025]; /* control 0x40 + 128x64/8 bytes */

static uint32_t now_ms(void) { return (uint32_t)(esp_timer_get_time()/1000); }
static uint32_t now_us(void) { return (uint32_t)esp_timer_get_time(); }
static TickType_t ticks(unsigned ms) { TickType_t n=pdMS_TO_TICKS(ms); return n?n:1; }
static links_t get_links(void)
{
    portENTER_CRITICAL(&link_mux); links_t copy=links; portEXIT_CRITICAL(&link_mux);
    return copy;
}
static machine_t get_snapshot(void)
{
    portENTER_CRITICAL(&state_mux); machine_t copy=snapshot; portEXIT_CRITICAL(&state_mux);
    return copy;
}
static void publish_snapshot(void)
{
    portENTER_CRITICAL(&state_mux); snapshot=machine; portEXIT_CRITICAL(&state_mux);
}
static const char *direction_name(direction_t dir)
{
    return dir==FORWARD?"FWD":dir==REVERSE?"REV":"STOP";
}

/* ---------- Un solo formato de telemetria, igual al Arduino ---------- */
static void format_telemetry(const machine_t *s, char out[LINE_SIZE])
{
    char position[24];
    if(s->hc_valid) snprintf(position,sizeof(position),"%.1f",(double)s->position);
    else strcpy(position,"NA");
    snprintf(out,LINE_SIZE,
        "DIR=%s,V=%d,M=%d,RPM_M=%.1f,RPM_T=%.1f,RPM_R=%.1f,"
        "VEL_T=%.2f,VEL_R=%.2f,DIST=%.1f,POS=%s,ERR=%.1f,STATE=%s",
        direction_name(s->actual),s->percent,s->microsteps,
        (double)s->motor_rpm,(double)s->roller_theory,(double)s->roller_real,
        (double)s->speed_theory,(double)s->speed_real,(double)s->distance,
        position,(double)s->error,
        s->divergence?"DIVERG":(!s->in_regime&&s->actual!=STOPPED)?"RAMP":"OK");
}
static void queue_line(QueueHandle_t queue, const char *text, uint32_t epoch)
{
    tx_line_t line={.epoch=epoch};
    snprintf(line.text,sizeof(line.text),"%s\r\n",text);
    /* Nunca esperar una salida lenta desde la tarea de control. */
    (void)xQueueSend(queue,&line,0);
}
static void emit_line(const char *text, bool local, bool remote)
{
    links_t l=get_links();
    if(local) {
        queue_line(usb_tx,text,0);
        if(l.bt_handle) queue_line(bt_tx,text,l.bt_epoch);
    }
    if(remote&&l.ws) queue_line(ws_tx,text,l.ws_epoch);
}

/* ---------- STEP por GPTimer y encoder/eco por interrupcion ---------- */
static bool IRAM_ATTR step_alarm(gptimer_handle_t timer,
                                const gptimer_alarm_event_data_t *event,void *arg)
{
    (void)timer;(void)event;(void)arg;
    portENTER_CRITICAL_ISR(&step_mux);
    if(step_enabled) { step_high=!step_high; gpio_set_level(STEP_PIN,step_high); }
    portEXIT_CRITICAL_ISR(&step_mux);
    return false;
}
static void stop_steps(void)
{
    portENTER_CRITICAL(&step_mux);
    step_enabled=false;step_high=false;gpio_set_level(STEP_PIN,0);
    portEXIT_CRITICAL(&step_mux);
    if(timer_running) { ESP_ERROR_CHECK(gptimer_stop(step_timer));timer_running=false; }
    last_step_rate=-1.0f;
}
static void apply_step_rate(float rate)
{
    if(rate<0.5f) { stop_steps();return; }
    if(fabsf(rate-last_step_rate)<1.0f) return;
    last_step_rate=rate;
    uint64_t half=(uint64_t)(STEP_TIMER_HZ/(2.0*(double)rate));
    if(half<2)half=2;
    gptimer_alarm_config_t alarm={.alarm_count=half,.reload_count=0,
                                  .flags.auto_reload_on_alarm=true};
    ESP_ERROR_CHECK(gptimer_set_alarm_action(step_timer,&alarm));
    if(!timer_running) {
        ESP_ERROR_CHECK(gptimer_set_raw_count(step_timer,0));
        portENTER_CRITICAL(&step_mux);step_enabled=true;portEXIT_CRITICAL(&step_mux);
        ESP_ERROR_CHECK(gptimer_start(step_timer));timer_running=true;
    }
}
static void apply_direction(void)
{
    if(machine.actual!=STOPPED) gpio_set_level(DIR_PIN,machine.actual==FORWARD);
}
static void configure_microsteps(int value)
{
    gpio_set_level(MS1_PIN,value==2||value==16);
    gpio_set_level(MS2_PIN,value==4||value==16);
    machine.microsteps=value;
}
static void IRAM_ATTR encoder_isr(void *arg)
{
    (void)arg;
    uint32_t current=(uint32_t)esp_timer_get_time();
    portENTER_CRITICAL_ISR(&encoder_mux);
    if((uint32_t)(current-encoder_last_us)>=ENCODER_MIN_GAP_US) {
        encoder_last_us=current;encoder_pulses++;
    }
    portEXIT_CRITICAL_ISR(&encoder_mux);
}
static void IRAM_ATTR echo_isr(void *arg)
{
    (void)arg;
    uint32_t current=(uint32_t)esp_timer_get_time();
    int high=gpio_get_level(ECHO_PIN);
    portENTER_CRITICAL_ISR(&echo_mux);
    if(echo_waiting&&(uint32_t)(current-echo_start_us)<=HC_TIMEOUT_US) {
        if(high&&!echo_risen) { echo_rise_us=current;echo_risen=true; }
        else if(!high&&echo_risen) {
            echo_duration=current-echo_rise_us;echo_ready=true;echo_waiting=false;
        }
    }
    portEXIT_CRITICAL_ISR(&echo_mux);
}
static void control_hardware_init(void)
{
    gptimer_config_t config={.clk_src=GPTIMER_CLK_SRC_DEFAULT,
                            .direction=GPTIMER_COUNT_UP,.resolution_hz=STEP_TIMER_HZ};
    ESP_ERROR_CHECK(gptimer_new_timer(&config,&step_timer));
    gptimer_event_callbacks_t callbacks={.on_alarm=step_alarm};
    ESP_ERROR_CHECK(gptimer_register_event_callbacks(step_timer,&callbacks,NULL));
    ESP_ERROR_CHECK(gptimer_enable(step_timer));
    gpio_config_t encoder={.pin_bit_mask=1ULL<<ENCODER_PIN,.mode=GPIO_MODE_INPUT,
        .pull_up_en=GPIO_PULLUP_ENABLE,.intr_type=GPIO_INTR_POSEDGE};
    ESP_ERROR_CHECK(gpio_config(&encoder));
    gpio_config_t echo={.pin_bit_mask=1ULL<<ECHO_PIN,.mode=GPIO_MODE_INPUT,
                       .intr_type=GPIO_INTR_ANYEDGE};
    ESP_ERROR_CHECK(gpio_config(&echo));
    ESP_ERROR_CHECK(gpio_install_isr_service(ESP_INTR_FLAG_IRAM));
    ESP_ERROR_CHECK(gpio_isr_handler_add(ENCODER_PIN,encoder_isr,NULL));
    ESP_ERROR_CHECK(gpio_isr_handler_add(ECHO_PIN,echo_isr,NULL));
    configure_microsteps(8);gpio_set_level(EN_PIN,0);
}

/* ---------- Misma rampa, M/T, filtro y criterio de divergencia ---------- */
static void update_motor(float dt,uint32_t current)
{
    if(machine.actual==STOPPED&&machine.requested!=STOPPED&&machine.motor_rpm<0.1f) {
        machine.actual=machine.requested;apply_direction();
    }
    machine.target_rpm=machine.requested==STOPPED?0:MAX_MOTOR_RPM*(machine.percent/100.0f);
    float temporary=machine.target_rpm;
    if(machine.actual!=machine.requested&&machine.actual!=STOPPED) temporary=0;
    if(machine.motor_rpm<temporary) {
        machine.motor_rpm+=ACCEL_RPM_PER_SEC*dt;
        if(machine.motor_rpm>temporary) machine.motor_rpm=temporary;
    } else if(machine.motor_rpm>temporary) {
        machine.motor_rpm-=DECEL_RPM_PER_SEC*dt;
        if(machine.motor_rpm<temporary) machine.motor_rpm=temporary;
    }
    if(machine.motor_rpm<0.1f&&machine.actual!=machine.requested) {
        machine.motor_rpm=0;
        stop_steps(); /* STEP bajo antes de cambiar DIR. */
        machine.actual=machine.requested;apply_direction();
    }
    machine.roller_theory=machine.motor_rpm*(MOTOR_GEAR_TEETH/ROLLER_GEAR_TEETH);
    machine.speed_theory=machine.roller_theory*(3.14159265358979323846f*(ROLLER_DIAMETER_MM/10.0f))/60.0f;
    bool regime=machine.target_rpm>0&&fabsf(machine.motor_rpm-machine.target_rpm)<2.0f;
    if(regime&&!machine.in_regime) machine.regime_since=current;
    machine.in_regime=regime;
    machine.step_rate=machine.motor_rpm*MOTOR_STEPS*machine.microsteps/60.0f;
    apply_step_rate(machine.step_rate);
}
static void encoder_measurement(uint32_t pulses,uint32_t last_us,uint32_t current_us)
{
    if(pulses>0) {
        if(encoder_ref_us) {
            uint32_t dt=last_us-encoder_ref_us;
            if(dt>0) machine.roller_real=(pulses/ENCODER_PPR)*60.0e6f/(float)dt;
        }
        encoder_ref_us=last_us;
    } else if((uint32_t)(current_us-last_us)>ENCODER_STOP_TIMEOUT_US) {
        machine.roller_real=0;encoder_ref_us=0;
    }
    machine.speed_real=machine.roller_real*(3.14159265358979323846f*(ROLLER_DIAMETER_MM/10.0f))/60.0f;
    machine.error=machine.roller_theory>1.0f?
        fabsf(machine.roller_real-machine.roller_theory)/machine.roller_theory*100.0f:0;
}
static void update_encoder(void)
{
    portENTER_CRITICAL(&encoder_mux);
    uint32_t count=encoder_pulses,last=encoder_last_us;encoder_pulses=0;
    portEXIT_CRITICAL(&encoder_mux);
    encoder_measurement(count,last,now_us());
}
static void hc_measurement(uint32_t duration)
{
    if(!duration) { machine.hc_valid=false;return; }
    float distance=(duration*0.0343f)/2.0f;machine.distance=distance;
    if(distance>=machine.hc_offset-1.0f&&distance<=machine.hc_offset+BELT_LENGTH_CM+2.0f) {
        float position=fminf(BELT_LENGTH_CM,fmaxf(0,distance-machine.hc_offset));
        if(machine.first_hc) { machine.position=position;machine.first_hc=false; }
        else machine.position=HC_ALPHA*position+(1.0f-HC_ALPHA)*machine.position;
        machine.hc_valid=true;
    } else machine.hc_valid=false;
}
static void update_hc(uint32_t current,uint32_t *last_sample)
{
    bool complete=false;uint32_t duration=0,us=now_us();
    portENTER_CRITICAL(&echo_mux);
    if(echo_ready) { complete=true;duration=echo_duration;echo_ready=false; }
    else if(echo_waiting&&(uint32_t)(us-echo_start_us)>=HC_TIMEOUT_US) {
        complete=true;echo_waiting=false;
    }
    portEXIT_CRITICAL(&echo_mux);
    if(complete)hc_measurement(duration);
    if((uint32_t)(current-*last_sample)<HC_SAMPLE_MS)return;
    *last_sample=current;
    portENTER_CRITICAL(&echo_mux);
    echo_waiting=true;echo_risen=false;echo_ready=false;echo_start_us=now_us();
    portEXIT_CRITICAL(&echo_mux);
    gpio_set_level(TRIG_PIN,0);esp_rom_delay_us(2);
    gpio_set_level(TRIG_PIN,1);esp_rom_delay_us(10);gpio_set_level(TRIG_PIN,0);
}
static void update_divergence(uint32_t current)
{
    machine.divergence=machine.roller_theory>5.0f&&machine.in_regime&&
        (uint32_t)(current-machine.regime_since)>(ENCODER_SAMPLE_MS+DIVERGENCE_MARGIN_MS)&&
        machine.error>SPEED_ERROR_LIMIT;
}

/* ---------- Un unico interprete: UART, SPP y WS ---------- */
static bool command_live(const command_t *command)
{
    links_t l=get_links();
    if(command->source==SRC_WS)return l.ws&&command->epoch==l.ws_epoch;
    if(command->source==SRC_BT)return l.bt_handle&&command->epoch==l.bt_epoch;
    return true;
}
static void submit_command(source_t source,uint32_t epoch,const char *input)
{
    command_t command={.source=source,.epoch=epoch};
    while(isspace((unsigned char)*input))input++;
    size_t n=strlen(input);
    while(n&&isspace((unsigned char)input[n-1]))n--;
    if(!n)return;
    if(n>=sizeof(command.text))return;
    for(size_t i=0;i<n;i++)command.text[i]=(char)toupper((unsigned char)input[i]);
    portENTER_CRITICAL(&input_mux);
    command.sequence=++command_sequence;
    if(!strcmp(command.text,"E")) { urgent_stop[source]=command;urgent_pending[source]=true; }
    portEXIT_CRITICAL(&input_mux);
    if(!strcmp(command.text,"E"))return; /* E no depende de espacio en la cola. */
    if(xQueueSend(commands,&command,0)!=pdTRUE)emit_line("Error: cola de comandos llena",true,true);
}
static void stream_feed(source_t source,uint32_t epoch,const char *data,size_t length,bool finish)
{
    for(size_t i=0;i<length+(finish?1U:0U);i++) {
        char c=i<length?data[i]:'\n',ready[CMD_SIZE]={0};bool invalid=false;
        portENTER_CRITICAL(&input_mux);
        stream_t *s=&streams[source];
        if(s->epoch!=epoch) { memset(s,0,sizeof(*s));s->epoch=epoch; }
        s->last_ms=now_ms();
        if(c=='\r'||c=='\n') {
            invalid=s->discard;
            if(!s->discard&&s->used)memcpy(ready,s->text,s->used);
            s->used=0;s->discard=false;
        } else if(!s->discard) {
            if((unsigned char)c<32|| (unsigned char)c>126 || s->used>=CMD_SIZE-1) {
                s->discard=true;s->used=0;
            } else s->text[s->used++]=c;
        }
        portEXIT_CRITICAL(&input_mux);
        if(invalid)emit_line("Comando invalido",true,true);
        if(ready[0])submit_command(source,epoch,ready);
    }
}
static void stream_timeouts(uint32_t current)
{
    for(source_t source=SRC_USB;source<=SRC_BT;source++) {
        char ready[CMD_SIZE]={0};uint32_t epoch;bool invalid=false;
        portENTER_CRITICAL(&input_mux);
        stream_t *s=&streams[source];epoch=s->epoch;
        if((s->used||s->discard)&&(uint32_t)(current-s->last_ms)>COMMAND_TIMEOUT_MS) {
            invalid=s->discard;
            if(!s->discard)memcpy(ready,s->text,s->used);
            s->used=0;s->discard=false;
        }
        portEXIT_CRITICAL(&input_mux);
        if(invalid)emit_line("Comando invalido",true,true);
        if(ready[0])submit_command(source,epoch,ready);
    }
}
static bool integer_arg(const char *s,long *value)
{
    char *end;errno=0;*value=strtol(s,&end,10);
    return end!=s&&*end=='\0'&&errno==0;
}
static void process_command(const command_t *command)
{
    const char *cmd=command->text;char reply[LINE_SIZE];long value;
    if(!strcmp(cmd,"F")||!strcmp(cmd,"R")) {
        machine.requested=cmd[0]=='F'?FORWARD:REVERSE;machine.owner=command->source;
        strcpy(reply,cmd[0]=='F'?"Direccion: ADELANTE":"Direccion: REVERSA");
    } else if(!strcmp(cmd,"S")) {
        machine.requested=STOPPED;machine.owner=SRC_NONE;strcpy(reply,"STOP");
    } else if(!strcmp(cmd,"E")) {
        machine.requested=machine.actual=STOPPED;machine.motor_rpm=0;
        machine.target_rpm=machine.roller_theory=machine.speed_theory=machine.step_rate=0;
        machine.in_regime=false;machine.divergence=false;machine.owner=SRC_NONE;
        stop_steps();strcpy(reply,"STOP INMEDIATO");
    } else if(cmd[0]=='V') {
        if(integer_arg(cmd+1,&value)&&value>=0&&value<=100) {
            machine.percent=(int)value;
            if(!value) { machine.requested=STOPPED;machine.owner=SRC_NONE; }
            else if(machine.requested!=STOPPED)machine.owner=command->source;
            snprintf(reply,sizeof(reply),"Velocidad: %d%%",machine.percent);
        } else strcpy(reply,"V debe ser 0-100");
    } else if(cmd[0]=='M') {
        if(!integer_arg(cmd+1,&value)||(value!=2&&value!=4&&value!=8&&value!=16))
            strcpy(reply,"Use M2 M4 M8 M16");
        else if(machine.actual!=STOPPED||machine.motor_rpm>0)
            strcpy(reply,"Detener (S) antes de cambiar M");
        else {
            stop_steps();gpio_set_level(EN_PIN,1);vTaskDelay(ticks(5));
            configure_microsteps((int)value);vTaskDelay(ticks(5));gpio_set_level(EN_PIN,0);
            snprintf(reply,sizeof(reply),"Microstep: 1/%d",machine.microsteps);
        }
    } else if(cmd[0]=='O') {
        char *end;errno=0;float offset=strtof(cmd+1,&end);
        if(end!=cmd+1&&!*end&&!errno&&isfinite(offset)&&offset>=0&&offset<20) {
            machine.hc_offset=offset;snprintf(reply,sizeof(reply),"Offset HC: %.2f",(double)offset);
        } else strcpy(reply,"Offset invalido");
    } else if(!strcmp(cmd,"STATUS"))format_telemetry(&machine,reply);
    else strcpy(reply,"Comando invalido");
    publish_snapshot();emit_line(reply,true,true);
}
static void handle_remote_loss(void)
{
    portENTER_CRITICAL(&link_mux);bool lost=links.remote_lost;links.remote_lost=false;portEXIT_CRITICAL(&link_mux);
    if(lost&&machine.owner==SRC_WS) {
        machine.requested=STOPPED;machine.owner=SRC_NONE;
        emit_line("Enlace WS perdido: STOP; control local disponible",true,false);
    }
}
static void control_task(void *arg)
{
    (void)arg;control_hardware_init();publish_snapshot();
    xEventGroupSetBits(flags,CONTROL_READY);
    vTaskDelay(ticks(800));
    emit_line("CINTA TRANSPORTADORA UTEC\r\nBluetooth: CINTA_UTEC\r\nF/R/S/E V0..100 M2/M4/M8/M16 O4.0 STATUS",true,false);
    uint32_t motor_at=now_ms(),encoder_at=motor_at,hc_at=0,telemetry_at=0,ws_at=0;
    uint32_t emergency_barrier=0;char bytes[64],line[LINE_SIZE];
    for(;;) {
        int n=uart_read_bytes(UART_NUM_0,bytes,sizeof(bytes),0);
        if(n>0)stream_feed(SRC_USB,0,bytes,(size_t)n,false);
        uint32_t current=now_ms();stream_timeouts(current);handle_remote_loss();
        command_t command;
        for(source_t source=SRC_USB;source<=SRC_WS;source++) {
            portENTER_CRITICAL(&input_mux);bool urgent=urgent_pending[source];
            if(urgent) { command=urgent_stop[source];urgent_pending[source]=false; }
            portEXIT_CRITICAL(&input_mux);
            if(urgent&&command_live(&command)) {
                if((int32_t)(command.sequence-emergency_barrier)>0)emergency_barrier=command.sequence;
                process_command(&command);
            }
        }
        for(int i=0;i<8&&xQueueReceive(commands,&command,0)==pdTRUE;i++) {
            if((int32_t)(command.sequence-emergency_barrier)>0&&command_live(&command))process_command(&command);
        }
        current=now_ms();
        if((uint32_t)(current-motor_at)>=20U) {
            update_motor((current-motor_at)/1000.0f,current);motor_at=current;
        }
        if((uint32_t)(current-encoder_at)>=ENCODER_SAMPLE_MS) { encoder_at=current;update_encoder(); }
        update_hc(current,&hc_at);update_divergence(current);publish_snapshot();
        bool local=(uint32_t)(current-telemetry_at)>=TELEMETRY_MS;
        bool remote=(uint32_t)(current-ws_at)>=WS_TELEMETRY_MS;
        if(local||remote) {
            format_telemetry(&machine,line);emit_line(line,local,remote);
            if(local)telemetry_at=current;
            if(remote)ws_at=current;
        }
        vTaskDelay(ticks(2));
    }
}

/* ---------- OLED SSD1306 nativa, framebuffer y fuente original 5x7 ---------- */
/*
 * https://github.com/adafruit/Adafruit-GFX-Library/blob/master/glcdfont.c
 *
 * Software License Agreement (BSD License)
 * 
 * Copyright (c) 2012 Adafruit Industries.  All rights reserved.
 * 
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 * 
 * - Redistributions of source code must retain the above copyright notice,
 *   this list of conditions and the following disclaimer.
 * - Redistributions in binary form must reproduce the above copyright notice,
 *   this list of conditions and the following disclaimer in the documentation
 *   and/or other materials provided with the distribution.
 * 
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
 * LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 * POSSIBILITY OF SUCH DAMAGE.
 */
static const uint8_t font5x7[95][5]={
    {0x00,0x00,0x00,0x00,0x00},
    {0x00,0x00,0x5F,0x00,0x00},
    {0x00,0x07,0x00,0x07,0x00},
    {0x14,0x7F,0x14,0x7F,0x14},
    {0x24,0x2A,0x7F,0x2A,0x12},
    {0x23,0x13,0x08,0x64,0x62},
    {0x36,0x49,0x56,0x20,0x50},
    {0x00,0x08,0x07,0x03,0x00},
    {0x00,0x1C,0x22,0x41,0x00},
    {0x00,0x41,0x22,0x1C,0x00},
    {0x2A,0x1C,0x7F,0x1C,0x2A},
    {0x08,0x08,0x3E,0x08,0x08},
    {0x00,0x80,0x70,0x30,0x00},
    {0x08,0x08,0x08,0x08,0x08},
    {0x00,0x00,0x60,0x60,0x00},
    {0x20,0x10,0x08,0x04,0x02},
    {0x3E,0x51,0x49,0x45,0x3E},
    {0x00,0x42,0x7F,0x40,0x00},
    {0x72,0x49,0x49,0x49,0x46},
    {0x21,0x41,0x49,0x4D,0x33},
    {0x18,0x14,0x12,0x7F,0x10},
    {0x27,0x45,0x45,0x45,0x39},
    {0x3C,0x4A,0x49,0x49,0x31},
    {0x41,0x21,0x11,0x09,0x07},
    {0x36,0x49,0x49,0x49,0x36},
    {0x46,0x49,0x49,0x29,0x1E},
    {0x00,0x00,0x14,0x00,0x00},
    {0x00,0x40,0x34,0x00,0x00},
    {0x00,0x08,0x14,0x22,0x41},
    {0x14,0x14,0x14,0x14,0x14},
    {0x00,0x41,0x22,0x14,0x08},
    {0x02,0x01,0x59,0x09,0x06},
    {0x3E,0x41,0x5D,0x59,0x4E},
    {0x7C,0x12,0x11,0x12,0x7C},
    {0x7F,0x49,0x49,0x49,0x36},
    {0x3E,0x41,0x41,0x41,0x22},
    {0x7F,0x41,0x41,0x41,0x3E},
    {0x7F,0x49,0x49,0x49,0x41},
    {0x7F,0x09,0x09,0x09,0x01},
    {0x3E,0x41,0x41,0x51,0x73},
    {0x7F,0x08,0x08,0x08,0x7F},
    {0x00,0x41,0x7F,0x41,0x00},
    {0x20,0x40,0x41,0x3F,0x01},
    {0x7F,0x08,0x14,0x22,0x41},
    {0x7F,0x40,0x40,0x40,0x40},
    {0x7F,0x02,0x1C,0x02,0x7F},
    {0x7F,0x04,0x08,0x10,0x7F},
    {0x3E,0x41,0x41,0x41,0x3E},
    {0x7F,0x09,0x09,0x09,0x06},
    {0x3E,0x41,0x51,0x21,0x5E},
    {0x7F,0x09,0x19,0x29,0x46},
    {0x26,0x49,0x49,0x49,0x32},
    {0x03,0x01,0x7F,0x01,0x03},
    {0x3F,0x40,0x40,0x40,0x3F},
    {0x1F,0x20,0x40,0x20,0x1F},
    {0x3F,0x40,0x38,0x40,0x3F},
    {0x63,0x14,0x08,0x14,0x63},
    {0x03,0x04,0x78,0x04,0x03},
    {0x61,0x59,0x49,0x4D,0x43},
    {0x00,0x7F,0x41,0x41,0x41},
    {0x02,0x04,0x08,0x10,0x20},
    {0x00,0x41,0x41,0x41,0x7F},
    {0x04,0x02,0x01,0x02,0x04},
    {0x40,0x40,0x40,0x40,0x40},
    {0x00,0x03,0x07,0x08,0x00},
    {0x20,0x54,0x54,0x78,0x40},
    {0x7F,0x28,0x44,0x44,0x38},
    {0x38,0x44,0x44,0x44,0x28},
    {0x38,0x44,0x44,0x28,0x7F},
    {0x38,0x54,0x54,0x54,0x18},
    {0x00,0x08,0x7E,0x09,0x02},
    {0x18,0xA4,0xA4,0x9C,0x78},
    {0x7F,0x08,0x04,0x04,0x78},
    {0x00,0x44,0x7D,0x40,0x00},
    {0x20,0x40,0x40,0x3D,0x00},
    {0x7F,0x10,0x28,0x44,0x00},
    {0x00,0x41,0x7F,0x40,0x00},
    {0x7C,0x04,0x78,0x04,0x78},
    {0x7C,0x08,0x04,0x04,0x78},
    {0x38,0x44,0x44,0x44,0x38},
    {0xFC,0x18,0x24,0x24,0x18},
    {0x18,0x24,0x24,0x18,0xFC},
    {0x7C,0x08,0x04,0x04,0x08},
    {0x48,0x54,0x54,0x54,0x24},
    {0x04,0x04,0x3F,0x44,0x24},
    {0x3C,0x40,0x40,0x20,0x7C},
    {0x1C,0x20,0x40,0x20,0x1C},
    {0x3C,0x40,0x30,0x40,0x3C},
    {0x44,0x28,0x10,0x28,0x44},
    {0x4C,0x90,0x90,0x90,0x7C},
    {0x44,0x64,0x54,0x4C,0x44},
    {0x00,0x08,0x36,0x41,0x00},
    {0x00,0x00,0x77,0x00,0x00},
    {0x00,0x41,0x36,0x08,0x00},
    {0x02,0x01,0x02,0x04,0x02},
};

static void oled_text(int x,int y,const char *text)
{
    while(*text) {
        unsigned char c=(unsigned char)*text++;
        if(c=='\r')continue;
        if(c=='\n') { x=0;y+=8;continue; }
        if(x+6>128) { x=0;y+=8; }
        if(c<32||c>126)c='?';
        for(int col=0;col<5;col++)for(int row=0;row<8;row++) {
            int py=y+row;
            if(py>=0&&py<64&&(font5x7[c-32][col]&(1U<<row)))
                oled_frame[1+(py/8)*128+x+col]|=(uint8_t)(1U<<(py%8));
        }
        x+=6;
    }
}
static esp_err_t oled_flush(void)
{
    const uint8_t address[]={0x00,0x21,0,127,0x22,0,7};
    esp_err_t result=i2c_master_transmit(oled,address,sizeof(address),50);
    if(result==ESP_OK)result=i2c_master_transmit(oled,oled_frame,sizeof(oled_frame),50);
    return result;
}
static esp_err_t oled_init(void)
{
    i2c_master_bus_handle_t bus;
    i2c_master_bus_config_t config={.i2c_port=I2C_NUM_0,.sda_io_num=SDA_PIN,.scl_io_num=SCL_PIN,
        .clk_source=I2C_CLK_SRC_DEFAULT,.glitch_ignore_cnt=7,.flags.enable_internal_pullup=true};
    esp_err_t result=i2c_new_master_bus(&config,&bus);if(result!=ESP_OK)return result;
    i2c_device_config_t device={.dev_addr_length=I2C_ADDR_BIT_LEN_7,
        .device_address=OLED_ADDRESS,.scl_speed_hz=I2C_CLOCK_HZ};
    result=i2c_master_bus_add_device(bus,&device,&oled);if(result!=ESP_OK)return result;
    /* Mismos parametros 128x64, carga interna y orientacion de Adafruit. */
    const uint8_t init[]={0x00,0xAE,0xD5,0x80,0xA8,0x3F,0xD3,0x00,0x40,
        0x8D,0x14,0x20,0x00,0xA1,0xC8,0xDA,0x12,0x81,0xCF,0xD9,0xF1,
        0xDB,0x40,0xA4,0xA6,0x2E,0xAF};
    result=i2c_master_transmit(oled,init,sizeof(init),100);if(result!=ESP_OK)return result;
    memset(oled_frame,0,sizeof(oled_frame));oled_frame[0]=0x40;
    oled_text(0,8,"CINTA TRANSPORTADORA");oled_text(0,25,"ESP32 + TMC2208");
    oled_text(0,42,"Iniciando...");return oled_flush();
}
static void oled_task(void *arg)
{
    (void)arg;vTaskDelay(ticks(800));TickType_t wake=xTaskGetTickCount();
    for(;;) {
        machine_t s=get_snapshot();char text[96];
        memset(oled_frame+1,0,sizeof(oled_frame)-1);
        snprintf(text,sizeof(text),"%s V:%d%% M:%d",direction_name(s.actual),s.percent,s.microsteps);
        oled_text(0,0,text);
        snprintf(text,sizeof(text),"RPM T:%.1f R:%.1f",(double)s.roller_theory,(double)s.roller_real);
        oled_text(0,11,text);
        snprintf(text,sizeof(text),"cm/s T:%.1f R:%.1f",(double)s.speed_theory,(double)s.speed_real);
        oled_text(0,22,text);
        if(s.hc_valid)snprintf(text,sizeof(text),"Pos:%.1fcm",(double)s.position);
        else strcpy(text,"Pos:--.-cm");
        oled_text(0,33,text);
        snprintf(text,sizeof(text),"Err:%.1f%% %s",(double)s.error,s.divergence?"DIVERG":"OK");
        oled_text(0,44,text);
        snprintf(text,sizeof(text),"HC:%s BT:CINTA_UTEC",s.hc_valid?"OK":"---");
        oled_text(0,55,text);
        (void)oled_flush(); /* Un fallo I2C no bloquea STEP ni el control local. */
        xTaskDelayUntil(&wake,ticks(OLED_REFRESH_MS));
    }
}

/* ---------- USB y Bluetooth SPP, sin Arduino ---------- */
static void serial_tx_task(void *arg)
{
    (void)arg;tx_line_t line;
    for(;;) {
        if(xQueueReceive(usb_tx,&line,0)==pdTRUE)
            uart_write_bytes(UART_NUM_0,line.text,strlen(line.text));
        links_t l=get_links();
        if(l.bt_handle&&!l.bt_busy&&!l.bt_congested&&xQueueReceive(bt_tx,&line,0)==pdTRUE) {
            bool send=false;
            portENTER_CRITICAL(&link_mux);
            if(links.bt_handle==l.bt_handle&&links.bt_epoch==line.epoch&&!links.bt_busy&&!links.bt_congested) {
                links.bt_busy=true;send=true;
            }
            portEXIT_CRITICAL(&link_mux);
            if(send&&esp_spp_write(l.bt_handle,(int)strlen(line.text),(uint8_t *)line.text)!=ESP_OK) {
                portENTER_CRITICAL(&link_mux);
                if(links.bt_epoch==line.epoch)links.bt_busy=false;
                portEXIT_CRITICAL(&link_mux);
            }
        } else if(!l.bt_handle) { while(xQueueReceive(bt_tx,&line,0)==pdTRUE){} }
        vTaskDelay(ticks(5));
    }
}
static void bt_gap(esp_bt_gap_cb_event_t event,esp_bt_gap_cb_param_t *param)
{
    if(event==ESP_BT_GAP_PIN_REQ_EVT) {
        /* El .ino no configura PIN mediante SerialBT.setPin(). */
        esp_bt_pin_code_t pin={0};
        esp_bt_gap_pin_reply(param->pin_req.bda,!param->pin_req.min_16_digit,0,pin);
    } else if(event==ESP_BT_GAP_CFM_REQ_EVT)
        esp_bt_gap_ssp_confirm_reply(param->cfm_req.bda,false);
}
static void bt_event(esp_spp_cb_event_t event,esp_spp_cb_param_t *param)
{
    switch(event) {
    case ESP_SPP_INIT_EVT:
        if(param->init.status==ESP_SPP_SUCCESS)
            esp_spp_start_srv(ESP_SPP_SEC_NONE,ESP_SPP_ROLE_SLAVE,0,"SPP_SERVER");
        break;
    case ESP_SPP_START_EVT:
        if(param->start.status==ESP_SPP_SUCCESS) {
            esp_bt_gap_set_device_name(BT_NAME);
            esp_bt_gap_set_scan_mode(ESP_BT_CONNECTABLE,ESP_BT_GENERAL_DISCOVERABLE);
        }
        break;
    case ESP_SPP_SRV_OPEN_EVT: {
        if(param->srv_open.status!=ESP_SPP_SUCCESS)break;
        links_t l=get_links();
        if(l.bt_handle) { esp_spp_disconnect(param->srv_open.handle);break; }
        portENTER_CRITICAL(&link_mux);
        links.bt_handle=param->srv_open.handle;links.bt_epoch++;
        links.bt_busy=false;links.bt_congested=false;
        portEXIT_CRITICAL(&link_mux);break;
    }
    case ESP_SPP_CLOSE_EVT:
        portENTER_CRITICAL(&link_mux);
        if(links.bt_handle==param->close.handle) {
            links.bt_handle=0;links.bt_epoch++;links.bt_busy=false;links.bt_congested=false;
        }
        portEXIT_CRITICAL(&link_mux);break;
    case ESP_SPP_DATA_IND_EVT: {
        links_t l=get_links();
        if(l.bt_handle==param->data_ind.handle)
            stream_feed(SRC_BT,l.bt_epoch,(const char *)param->data_ind.data,param->data_ind.len,false);
        break;
    }
    case ESP_SPP_WRITE_EVT:
        portENTER_CRITICAL(&link_mux);
        if(links.bt_handle==param->write.handle) { links.bt_busy=false;links.bt_congested=param->write.cong; }
        portEXIT_CRITICAL(&link_mux);break;
    case ESP_SPP_CONG_EVT:
        portENTER_CRITICAL(&link_mux);
        if(links.bt_handle==param->cong.handle)links.bt_congested=param->cong.cong;
        portEXIT_CRITICAL(&link_mux);break;
    default:break;
    }
}
static void bluetooth_init(void)
{
    ESP_ERROR_CHECK(esp_bt_controller_mem_release(ESP_BT_MODE_BLE));
    esp_bt_controller_config_t controller=BT_CONTROLLER_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_bt_controller_init(&controller));
    ESP_ERROR_CHECK(esp_bt_controller_enable(ESP_BT_MODE_CLASSIC_BT));
    esp_bluedroid_config_t host=BT_BLUEDROID_INIT_CONFIG_DEFAULT();
    /* Configuracion base de Bluedroid, igual que BluetoothSerial.begin(). */
    ESP_ERROR_CHECK(esp_bluedroid_init_with_cfg(&host));
    ESP_ERROR_CHECK(esp_bluedroid_enable());
    ESP_ERROR_CHECK(esp_bt_gap_register_callback(bt_gap));
    ESP_ERROR_CHECK(esp_spp_register_callback(bt_event));
    esp_spp_cfg_t spp={.mode=ESP_SPP_MODE_CB,.enable_l2cap_ertm=true,.tx_buffer_size=0};
    ESP_ERROR_CHECK(esp_spp_enhanced_init(&spp));
    esp_bt_cod_t cod={.major=1,.minor=4,.service=0x16};
    ESP_ERROR_CHECK(esp_bt_gap_set_cod(cod,ESP_BT_INIT_COD));
}

/* ---------- Wi-Fi y WebSocket: callbacks breves, TX en otra tarea ---------- */
static void remote_down(void)
{
    portENTER_CRITICAL(&link_mux);
    links.ws=false;links.ws_epoch++;links.remote_lost=true;
    portEXIT_CRITICAL(&link_mux);
}
typedef struct { char text[128];size_t used;bool active,discard; } ws_message_t;
static ws_message_t ws_message;
static void websocket_event(void *arg,esp_event_base_t base,int32_t id,void *data)
{
    (void)arg;(void)base;
    if(id==WEBSOCKET_EVENT_CONNECTED) {
        memset(&ws_message,0,sizeof(ws_message));
        portENTER_CRITICAL(&link_mux);links.ws_epoch++;links.ws=links.wifi;portEXIT_CRITICAL(&link_mux);
        emit_line("WebSocket conectado",true,false);
    } else if(id==WEBSOCKET_EVENT_DISCONNECTED||id==WEBSOCKET_EVENT_CLOSED) {
        remote_down();memset(&ws_message,0,sizeof(ws_message));
    } else if(id==WEBSOCKET_EVENT_DATA) {
        const esp_websocket_event_data_t *e=data;
        if(e->op_code!=1&&e->op_code!=0)return; /* Ping/pong los maneja la biblioteca. */
        if(e->op_code==1&&e->payload_offset==0) {
            memset(&ws_message,0,sizeof(ws_message));ws_message.active=true;
        }
        if(!ws_message.active)return;
        if(e->data_len<0||e->payload_offset<0||e->payload_len<0||
           e->payload_offset>e->payload_len-e->data_len||
           ws_message.used+(size_t)e->data_len>=sizeof(ws_message.text))ws_message.discard=true;
        if(!ws_message.discard&&e->data_len) {
            if(memchr(e->data_ptr,'\0',(size_t)e->data_len))ws_message.discard=true;
            else { memcpy(ws_message.text+ws_message.used,e->data_ptr,(size_t)e->data_len);ws_message.used+=(size_t)e->data_len; }
        }
        if(e->fin&&e->payload_offset+e->data_len==e->payload_len) {
            links_t l=get_links();
            if(!ws_message.discard&&l.ws)
                stream_feed(SRC_WS,l.ws_epoch,ws_message.text,ws_message.used,true);
            else if(ws_message.discard)emit_line("Comando invalido",true,true);
            memset(&ws_message,0,sizeof(ws_message));
        }
    }
}
static void wifi_retry_callback(TimerHandle_t timer)
{
    (void)timer;(void)esp_wifi_connect();
}
static void wifi_event(void *arg,esp_event_base_t base,int32_t id,void *data)
{
    (void)arg;(void)data;
    if(base==WIFI_EVENT&&id==WIFI_EVENT_STA_START)esp_wifi_connect();
    else if(base==WIFI_EVENT&&id==WIFI_EVENT_STA_DISCONNECTED) {
        portENTER_CRITICAL(&link_mux);links.wifi=false;portEXIT_CRITICAL(&link_mux);
        xEventGroupClearBits(flags,WIFI_READY);remote_down();xTimerReset(wifi_retry,0);
    } else if(base==IP_EVENT&&id==IP_EVENT_STA_GOT_IP) {
        portENTER_CRITICAL(&link_mux);links.wifi=true;portEXIT_CRITICAL(&link_mux);
        xTimerStop(wifi_retry,0);xEventGroupSetBits(flags,WIFI_READY);
        emit_line("Wi-Fi conectado",true,false);
    }
}
static void network_task(void *arg)
{
    (void)arg;
    if(!strlen(CONFIG_CINTA_WIFI_SSID)) {
        emit_line("Configurar SSID y URL en menuconfig > Cinta UTEC; control local activo",true,false);
        vTaskDelete(NULL);return;
    }
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_t *netif=esp_netif_create_default_wifi_sta();
    ESP_ERROR_CHECK(netif?ESP_OK:ESP_ERR_NO_MEM);
    wifi_init_config_t init=WIFI_INIT_CONFIG_DEFAULT();ESP_ERROR_CHECK(esp_wifi_init(&init));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT,ESP_EVENT_ANY_ID,wifi_event,NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT,IP_EVENT_STA_GOT_IP,wifi_event,NULL));
    wifi_config_t config={0};
    size_t ssid_len=strlen(CONFIG_CINTA_WIFI_SSID),pass_len=strlen(CONFIG_CINTA_WIFI_PASSWORD);
    if(ssid_len>sizeof(config.sta.ssid)||pass_len>sizeof(config.sta.password)) {
        emit_line("SSID o clave demasiado largos; control local activo",true,false);vTaskDelete(NULL);return;
    }
    memcpy(config.sta.ssid,CONFIG_CINTA_WIFI_SSID,ssid_len);
    memcpy(config.sta.password,CONFIG_CINTA_WIFI_PASSWORD,pass_len);
    ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA,&config));
    ESP_ERROR_CHECK(esp_wifi_start());
    /* Coexistencia Wi-Fi + Bluetooth conserva el arbitraje nativo. */
    esp_websocket_client_config_t ws_config={
        .uri=CONFIG_CINTA_WS_URI,.disable_auto_reconnect=false,.enable_close_reconnect=true,
        .reconnect_timeout_ms=3000,.network_timeout_ms=1500,
        .task_prio=4,.task_stack=4096,.buffer_size=512,
        .ping_interval_sec=5,.pingpong_timeout_sec=5,.keep_alive_enable=true,
    };
    ws_client=esp_websocket_client_init(&ws_config);
    if(!ws_client) { emit_line("Error al crear WebSocket; control local activo",true,false);vTaskDelete(NULL);return; }
    ESP_ERROR_CHECK(esp_websocket_register_events(ws_client,WEBSOCKET_EVENT_ANY,websocket_event,NULL));
    xEventGroupWaitBits(flags,WIFI_READY,pdFALSE,pdTRUE,portMAX_DELAY);
    ESP_ERROR_CHECK(esp_websocket_client_start(ws_client));
    tx_line_t line;
    for(;;) {
        if(xQueueReceive(ws_tx,&line,ticks(20))==pdTRUE) {
            links_t l=get_links();
            if(l.ws&&l.ws_epoch==line.epoch&&esp_websocket_client_is_connected(ws_client))
                (void)esp_websocket_client_send_text(ws_client,line.text,(int)strlen(line.text),ticks(200));
        }
    }
}

void app_main(void)
{
    gpio_config_t output={.pin_bit_mask=(1ULL<<STEP_PIN)|(1ULL<<DIR_PIN)|(1ULL<<EN_PIN)|
        (1ULL<<MS1_PIN)|(1ULL<<MS2_PIN)|(1ULL<<TRIG_PIN),.mode=GPIO_MODE_OUTPUT};
    ESP_ERROR_CHECK(gpio_config(&output));
    gpio_set_level(EN_PIN,1);gpio_set_level(STEP_PIN,0);gpio_set_level(DIR_PIN,1);
    gpio_set_level(TRIG_PIN,0);
    uart_config_t uart={.baud_rate=115200,.data_bits=UART_DATA_8_BITS,.parity=UART_PARITY_DISABLE,
        .stop_bits=UART_STOP_BITS_1,.flow_ctrl=UART_HW_FLOWCTRL_DISABLE,.source_clk=UART_SCLK_DEFAULT};
    ESP_ERROR_CHECK(uart_param_config(UART_NUM_0,&uart));
    ESP_ERROR_CHECK(uart_set_pin(UART_NUM_0,1,3,UART_PIN_NO_CHANGE,UART_PIN_NO_CHANGE));
    ESP_ERROR_CHECK(uart_driver_install(UART_NUM_0,2048,2048,0,NULL,0));
    esp_err_t nvs=nvs_flash_init();
    if(nvs==ESP_ERR_NVS_NO_FREE_PAGES||nvs==ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());nvs=nvs_flash_init();
    }
    ESP_ERROR_CHECK(nvs);
    if(oled_init()!=ESP_OK) {
        const char error[]="ERROR OLED\r\n";uart_write_bytes(UART_NUM_0,error,sizeof(error)-1);
        /* Igual que el original: no arrancar sin inicializar la pantalla. */
        return;
    }
    commands=xQueueCreate(24,sizeof(command_t));usb_tx=xQueueCreate(16,sizeof(tx_line_t));
    bt_tx=xQueueCreate(12,sizeof(tx_line_t));ws_tx=xQueueCreate(16,sizeof(tx_line_t));
    flags=xEventGroupCreate();wifi_retry=xTimerCreate("wifi_retry",ticks(2000),pdFALSE,NULL,wifi_retry_callback);
    ESP_ERROR_CHECK(commands&&usb_tx&&bt_tx&&ws_tx&&flags&&wifi_retry?ESP_OK:ESP_ERR_NO_MEM);
    publish_snapshot();
    ESP_ERROR_CHECK(xTaskCreatePinnedToCore(control_task,"cinta_control",6144,NULL,10,NULL,CONTROL_CORE)==pdPASS?ESP_OK:ESP_ERR_NO_MEM);
    xEventGroupWaitBits(flags,CONTROL_READY,pdFALSE,pdTRUE,portMAX_DELAY);
    ESP_ERROR_CHECK(xTaskCreatePinnedToCore(oled_task,"cinta_oled",3072,NULL,2,NULL,CONTROL_CORE)==pdPASS?ESP_OK:ESP_ERR_NO_MEM);
    ESP_ERROR_CHECK(xTaskCreatePinnedToCore(serial_tx_task,"cinta_serial",3072,NULL,3,NULL,0)==pdPASS?ESP_OK:ESP_ERR_NO_MEM);
    bluetooth_init();
    ESP_ERROR_CHECK(xTaskCreatePinnedToCore(network_task,"cinta_red",5120,NULL,3,NULL,0)==pdPASS?ESP_OK:ESP_ERR_NO_MEM);
}
