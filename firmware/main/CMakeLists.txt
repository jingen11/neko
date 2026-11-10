# The pet's GIFs come straight from the web app, so both draw the same cat.
set(PET_DIR "${CMAKE_CURRENT_LIST_DIR}/../../web/public/pet")
set(PET_ANIMS idle listen think talk happy sad eat sleep petted sleepy sick angry yawn)
list(TRANSFORM PET_ANIMS PREPEND "${PET_DIR}/" OUTPUT_VARIABLE PET_GIFS)
list(TRANSFORM PET_GIFS APPEND ".gif")

idf_component_register(SRCS "main.c"
                       INCLUDE_DIRS "."
                       REQUIRES nvs_flash esp_wifi esp_netif esp_event esp_timer json microlink
                       EMBED_FILES "../assets/DotGothic16-Regular.ttf" ${PET_GIFS})
