import socket

HOST = "0.0.0.0"
PORT = 5000
OUTPUT_FILE = "respuesta_escalon.csv"

HEADER = "time_us,state,step_hz,encoder_count,encoder_delta,rpm"


def main():
    servidor = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    servidor.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    servidor.bind((HOST, PORT))
    servidor.listen(1)
    print(f"Escuchando en {HOST}:{PORT}...")

    conn, addr = servidor.accept()
    print(f"Cliente conectado: {addr[0]}:{addr[1]}")

    archivo = open(OUTPUT_FILE, "w", newline="")
    buffer = ""
    header_detectada = False
    terminado = False

    try:
        while not terminado:
            datos = conn.recv(4096)
            if not datos:
                print("El ESP32 se desconecto.")
                break

            buffer += datos.decode("utf-8", errors="ignore")

            while "\n" in buffer:
                linea, buffer = buffer.split("\n", 1)
                linea = linea.strip()

                if not linea:
                    continue

                if linea == "END":
                    print("Fin de ensayo (END recibido).")
                    terminado = True
                    break

                if not header_detectada:
                    if linea == HEADER:
                        header_detectada = True
                        archivo.write(linea + "\n")
                        archivo.flush()
                        print("Cabecera detectada.")
                    continue

                archivo.write(linea + "\n")
                archivo.flush()
                print(linea)

    except KeyboardInterrupt:
        print("\nInterrumpido por el usuario (Ctrl+C).")
    finally:
        archivo.close()
        conn.close()
        servidor.close()
        print("Archivo y conexion cerrados.")


if __name__ == "__main__":
    main()