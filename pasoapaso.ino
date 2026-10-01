/*
TMC2208
STEP → D5
DIR  → D6
EN   → D7

Encoder
CLK/A → D2
DT/B  → D3
GND   → GND

OLED 0.91"
SDA → A4
SCL → A5
VCC → 5V o 3.3V según módulo
GND → GND

F      → Adelante
R      → Reversa
S      → Parar

V25    → 25 %
V50    → 50 %
V100   → 100 %

M2     → 1/2 paso
M4     → 1/4 paso
M8     → 1/8 paso
M16    → 1/16 paso


*/

#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <Keypad.h>

// =====================================================
// OLED 0.91" 128x32
// =====================================================

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 32
#define OLED_RESET -1

Adafruit_SSD1306 display(
  SCREEN_WIDTH,
  SCREEN_HEIGHT,
  &Wire,
  OLED_RESET
);

// =====================================================
// TMC2208
// =====================================================

#define STEP_PIN 5
#define DIR_PIN  6
#define EN_PIN   7

#define MS1_PIN  8
#define MS2_PIN  9

// =====================================================
// KEYPAD 4x4
// =====================================================

const byte FILAS = 4;
const byte COLUMNAS = 4;

char teclas[FILAS][COLUMNAS] = {
  {'1', '2', '3', 'A'},
  {'4', '5', '6', 'B'},
  {'7', '8', '9', 'C'},
  {'*', '0', '#', 'D'}
};

byte pinesFilas[FILAS] = {
  A0, A1, A2, A3
};

byte pinesColumnas[COLUMNAS] = {
  10, 11, 12, 13
};

Keypad teclado = Keypad(
  makeKeymap(teclas),
  pinesFilas,
  pinesColumnas,
  FILAS,
  COLUMNAS
);

// Número que se está escribiendo
String entradaTeclado = "";

// =====================================================
// MOTOR
// =====================================================

// NEMA 17HS4401
// 1.8° = 200 pasos completos/vuelta
#define MOTOR_STEPS 200

// Micropasos iniciales
int microsteps = 8;

// V100 = 40 RPM por ahora
#define MAX_RPM 40.0

// =====================================================
// ESTADO
// =====================================================

enum EstadoMotor {
  PARADO,
  ADELANTE,
  REVERSA
};

EstadoMotor estado = PARADO;

int velocidad = 50;

float rpmObjetivo = 0;
float stepRate = 0;

unsigned long stepInterval = 0;
unsigned long ultimoStep = 0;

unsigned long ultimoOLED = 0;

String comando = "";

// =====================================================
// SETUP
// =====================================================

void setup() {

  Serial.begin(115200);

  // ===================================================
  // TMC2208
  // ===================================================

  pinMode(STEP_PIN, OUTPUT);
  pinMode(DIR_PIN, OUTPUT);
  pinMode(EN_PIN, OUTPUT);

  pinMode(MS1_PIN, OUTPUT);
  pinMode(MS2_PIN, OUTPUT);

  digitalWrite(STEP_PIN, LOW);
  digitalWrite(DIR_PIN, HIGH);

  // EN activo en LOW
  digitalWrite(EN_PIN, LOW);

  // Iniciar en 1/8
  configurarMicrosteps(8);

  // ===================================================
  // OLED
  // ===================================================

  if (!display.begin(
        SSD1306_SWITCHCAPVCC,
        0x3C)) {

    Serial.println(F("Error OLED"));

    while (true);
  }

  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);

  display.setTextSize(1);
  display.setCursor(0, 0);

  display.println("Cinta transport.");
  display.println("Sistema listo");

  display.display();

  delay(1000);

  // ===================================================
  // SERIAL
  // ===================================================

  Serial.println();
Serial.println(F("========================"));
Serial.println(F(" CINTA TRANSPORTADORA"));
Serial.println(F("========================"));

Serial.println();
Serial.println(F("MONITOR SERIE:"));
Serial.println(F("F     = Adelante"));
Serial.println(F("R     = Reversa"));
Serial.println(F("S     = Stop"));
Serial.println(F("V50   = Velocidad 50%"));
Serial.println(F("M2    = 1/2"));
Serial.println(F("M4    = 1/4"));
Serial.println(F("M8    = 1/8"));
Serial.println(F("M16   = 1/16"));

Serial.println();
Serial.println(F("TECLADO:"));
Serial.println(F("A = Adelante"));
Serial.println(F("B = Reversa"));
Serial.println(F("C = Stop"));
Serial.println(F("D = Cambiar micropasos"));
Serial.println(F("Numero + # = Velocidad"));
Serial.println(F("* = Borrar entrada"));
}

// =====================================================
// LOOP
// =====================================================

void loop() {

  leerSerial();

  leerTeclado();

  actualizarVelocidad();

  moverMotor();

  actualizarOLED();
}

// =====================================================
// TECLADO
// =====================================================

void leerTeclado() {

  char tecla = teclado.getKey();

  if (!tecla) {
    return;
  }

  // DEBUG
  Serial.print("Tecla: ");
  Serial.println(tecla);

  // ===================================================
  // NUMEROS 0-9
  // ===================================================

  if (tecla >= '0' && tecla <= '9') {

    // Maximo 3 digitos (100)
    if (entradaTeclado.length() < 3) {

      entradaTeclado += tecla;

      Serial.print("Entrada velocidad: ");
      Serial.println(entradaTeclado);
    }

    return;
  }

  // ===================================================
  // # = CONFIRMAR VELOCIDAD
  // ===================================================

  if (tecla == '#') {

    if (entradaTeclado.length() == 0) {

      Serial.println("No hay velocidad ingresada");
      return;
    }

    int nuevaVelocidad = entradaTeclado.toInt();

    if (nuevaVelocidad >= 0 &&
        nuevaVelocidad <= 100) {

      velocidad = nuevaVelocidad;

      // Si ponemos 0, detenemos
      if (velocidad == 0) {
        estado = PARADO;
      }

      Serial.print("Velocidad fijada: ");
      Serial.print(velocidad);
      Serial.println("%");

    } else {

      Serial.println("Velocidad invalida (0-100)");
    }

    // Limpiar entrada
    entradaTeclado = "";

    return;
  }

  // ===================================================
  // * = BORRAR NUMERO
  // ===================================================

  if (tecla == '*') {

    entradaTeclado = "";

    Serial.println("Entrada borrada");

    return;
  }

  // ===================================================
  // A = ADELANTE
  // ===================================================

  if (tecla == 'A') {

    entradaTeclado = "";

    procesarComando("F");

    return;
  }

  // ===================================================
  // B = REVERSA
  // ===================================================

  if (tecla == 'B') {

    entradaTeclado = "";

    procesarComando("R");

    return;
  }

  // ===================================================
  // C = STOP
  // ===================================================

  if (tecla == 'C') {

    entradaTeclado = "";

    procesarComando("S");

    return;
  }

  // ===================================================
  // D = CAMBIAR MICROSTEP
  // ===================================================

  if (tecla == 'D') {

    entradaTeclado = "";

    int siguiente;

    if (microsteps == 2) {
      siguiente = 4;
    }
    else if (microsteps == 4) {
      siguiente = 8;
    }
    else if (microsteps == 8) {
      siguiente = 16;
    }
    else {
      siguiente = 2;
    }

    cambiarMicrostepsSeguro(siguiente);

    return;
  }
}


// =====================================================
// LEER MONITOR SERIAL
// =====================================================

void leerSerial() {

  while (Serial.available()) {

    char c = Serial.read();

    if (c == '\n' || c == '\r') {

      if (comando.length() > 0) {

        procesarComando(comando);

        comando = "";
      }

    } else {

      comando += c;
    }
  }
}

// =====================================================
// PROCESAR COMANDOS
// =====================================================

void procesarComando(String cmd) {

  cmd.trim();
  cmd.toUpperCase();

  // ===================================================
  // ADELANTE
  // ===================================================

  if (cmd == "F") {

    estado = ADELANTE;

    digitalWrite(DIR_PIN, HIGH);

    Serial.println(
      "Direccion: ADELANTE"
    );
  }

  // ===================================================
  // REVERSA
  // ===================================================

  else if (cmd == "R") {

    estado = REVERSA;

    digitalWrite(DIR_PIN, LOW);

    Serial.println(
      "Direccion: REVERSA"
    );
  }

  // ===================================================
  // STOP
  // ===================================================

  else if (cmd == "S") {

    estado = PARADO;

    digitalWrite(STEP_PIN, LOW);

    Serial.println(F("Motor detenido"));
  }

  // ===================================================
  // VELOCIDAD
  // ===================================================

  else if (cmd.startsWith("V")) {

    int nuevaVelocidad =
      cmd.substring(1).toInt();

    if (
      nuevaVelocidad >= 0 &&
      nuevaVelocidad <= 100
    ) {

      velocidad = nuevaVelocidad;

      if (velocidad == 0) {

        estado = PARADO;
      }

      Serial.print(F("Velocidad: "));
      Serial.print(velocidad);
      Serial.println("%");

    } else {

      Serial.println(
        "Velocidad invalida 0-100"
      );
    }
  }

  // ===================================================
  // MICROSTEPPING
  // ===================================================

  else if (cmd.startsWith("M")) {

    int nuevoMicrostep =
      cmd.substring(1).toInt();

    if (
      nuevoMicrostep == 2 ||
      nuevoMicrostep == 4 ||
      nuevoMicrostep == 8 ||
      nuevoMicrostep == 16
    ) {

      cambiarMicrostepsSeguro(
        nuevoMicrostep
      );

    } else {

      Serial.println(
        "Use M2, M4, M8 o M16"
      );
    }
  }

  // ===================================================
  // INVALIDO
  // ===================================================

  else {

    Serial.println(F("Comando invalido"));
  }
}

// =====================================================
// CONFIGURAR MICROSTEPS
// =====================================================

void configurarMicrosteps(int valor) {

  switch (valor) {

    // 1/2
    case 2:

      digitalWrite(
        MS1_PIN,
        HIGH
      );

      digitalWrite(
        MS2_PIN,
        LOW
      );

      break;

    // 1/4
    case 4:

      digitalWrite(
        MS1_PIN,
        LOW
      );

      digitalWrite(
        MS2_PIN,
        HIGH
      );

      break;

    // 1/8
    case 8:

      digitalWrite(
        MS1_PIN,
        LOW
      );

      digitalWrite(
        MS2_PIN,
        LOW
      );

      break;

    // 1/16
    case 16:

      digitalWrite(
        MS1_PIN,
        HIGH
      );

      digitalWrite(
        MS2_PIN,
        HIGH
      );

      break;
  }

  microsteps = valor;
}

// =====================================================
// CAMBIO SEGURO DE MICROSTEPS
// =====================================================

void cambiarMicrostepsSeguro(
  int valor
) {

  EstadoMotor estadoAnterior =
    estado;

  // Parar STEP
  digitalWrite(
    STEP_PIN,
    LOW
  );

  // Deshabilitar driver
  digitalWrite(
    EN_PIN,
    HIGH
  );

  delay(5);

  configurarMicrosteps(valor);

  delay(5);

  // Habilitar driver
  digitalWrite(
    EN_PIN,
    LOW
  );

  estado = estadoAnterior;

  Serial.print(
    "Micropasos: 1/"
  );

  Serial.println(
    microsteps
  );
}

// =====================================================
// VELOCIDAD
// =====================================================

void actualizarVelocidad() {

  if (
    estado == PARADO ||
    velocidad == 0
  ) {

    rpmObjetivo = 0;
    stepRate = 0;
    stepInterval = 0;

    return;
  }

  // V100 = MAX_RPM

  rpmObjetivo =
    MAX_RPM *
    (velocidad / 100.0);

  // Pasos por vuelta

  long stepsPerRev =
    MOTOR_STEPS *
    microsteps;

  // RPM → STEP/s

  stepRate =
    (
      rpmObjetivo *
      stepsPerRev
    ) / 60.0;

  if (stepRate < 1) {

    stepRate = 1;
  }

  stepInterval =
    1000000.0 /
    stepRate;
}

// =====================================================
// MOTOR
// =====================================================

void moverMotor() {

  if (
    estado == PARADO ||
    velocidad == 0
  ) {

    digitalWrite(
      STEP_PIN,
      LOW
    );

    return;
  }

  unsigned long ahora =
    micros();

  if (
    ahora - ultimoStep >=
    stepInterval
  ) {

    ultimoStep = ahora;

    digitalWrite(
      STEP_PIN,
      HIGH
    );

    delayMicroseconds(4);

    digitalWrite(
      STEP_PIN,
      LOW
    );
  }
}

// =====================================================
// OLED
// =====================================================

void actualizarOLED() {

  if (
    millis() - ultimoOLED <
    200
  ) {

    return;
  }

  ultimoOLED = millis();

  display.clearDisplay();

  // ===================================================
  // SI SE ESTA ESCRIBIENDO VELOCIDAD
  // ===================================================

  if (
    entradaTeclado.length() > 0
  ) {

    display.setTextSize(1);

    display.setCursor(
      0,
      0
    );

    display.print(
      "VEL> "
    );

    display.print(
      entradaTeclado
    );

    display.print(
      "%  #=OK"
    );

  } else {

    // =================================================
    // ESTADO NORMAL
    // =================================================

    display.setTextSize(1);

    display.setCursor(
      0,
      0
    );

    if (
      estado == ADELANTE
    ) {

      display.print(
        "FWD"
      );

    } else if (
      estado == REVERSA
    ) {

      display.print(
        "REV"
      );

    } else {

      display.print(
        "STOP"
      );
    }

    display.print(" ");

    display.print(
      velocidad
    );

    display.print("%");

    display.print(" M");

    display.print(
      microsteps
    );
  }

  // ===================================================
  // RPM
  // ===================================================

  display.setTextSize(2);

  display.setCursor(
    0,
    13
  );

  display.print(
    rpmObjetivo,
    1
  );

  display.setTextSize(1);

  display.print(
    " RPM"
  );

  display.display();
}