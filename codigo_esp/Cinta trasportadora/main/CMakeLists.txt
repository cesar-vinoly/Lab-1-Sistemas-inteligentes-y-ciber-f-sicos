idf_component_register(
    SRCS "main.c"
    INCLUDE_DIRS "."
    REQUIRES esp_driver_gpio esp_driver_gptimer esp_driver_i2c esp_driver_uart
             esp_timer esp_wifi esp_event esp_netif nvs_flash bt
             esp_websocket_client
)
